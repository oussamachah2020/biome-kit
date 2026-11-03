// Run Biome on the files staged for commit without ever touching anything the
// developer didn't stage.
//
// The old hook ran `biome check --write --staged` and then
// `git update-index --again`. Biome rewrites files in the working tree (unstaged
// hunks included) and `--again` re-stages whatever is in the working tree, so
// unstaged hunks of partially staged files silently joined the commit.
//
// This module instead:
//   1. reads the exact staged content (the index blob) of every staged file;
//   2. for files that also have unstaged changes, saves the developer's working
//      copy to a backup and temporarily makes the working file equal the staged
//      content, so Biome sees exactly what will be committed;
//   3. runs Biome on the real files (same ignore rules, config and exit codes
//      as before);
//   4. on any failure, puts every file back byte for byte; the index is never
//      touched;
//   5. on success, writes the fixed content into the index entry of each staged
//      path (git hash-object + git update-index --index-info; never `git add`),
//      and merges Biome's changes back into the developer's working copy with a
//      three-way merge, so their unstaged hunks survive. If the merge would
//      conflict, the working copy is left exactly as the developer wrote it.
//
// Plain Node (no Bun APIs, no dependencies): this runs on every teammate's machine.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "./proc.mjs";

const SKIPPED_MODES = new Set(["120000", "160000"]); // symlinks, submodules
const BIOME_CHUNK = 100;
const CONCURRENCY = 8;

export class StaleBackupError extends Error {
  constructor(backupDir) {
    super(`An earlier lintlane run was interrupted. Your files are saved in ${backupDir}`);
    this.name = "StaleBackupError";
    this.backupDir = backupDir;
  }
}

async function git(args, { cwd, input } = {}) {
  const result = await runProcess("git", args, { cwd, input });
  if (result.code !== 0) {
    const detail =
      result.stderr.toString().trim() || result.error?.message || `exit ${result.code}`;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return result.stdout;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i], i);
  });
  await Promise.all(workers);
  return results;
}

/**
 * Staged files that are added, copied or modified (not deleted, not symlinks or
 * submodules). Renames are reported as a delete plus an add, so the new path is
 * included and the old one is not.
 */
export async function listStagedFiles(cwd) {
  const out = await git(
    ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "--diff-filter=ACM"],
    { cwd },
  );
  const parts = out.toString("utf8").split("\0");
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [, mode, , sha] = parts[i].slice(1).split(" ");
    const path = parts[i + 1];
    if (!SKIPPED_MODES.has(mode)) files.push({ path, mode, sha });
  }
  return files;
}

async function backupDirFor(cwd) {
  const rel = (await git(["rev-parse", "--git-path", "lintlane-backup"], { cwd }))
    .toString()
    .trim();
  return resolve(cwd, rel);
}

/** Three-way merge of Biome's changes into the developer's working copy. */
async function mergeThreeWay({ base, ours, theirs }) {
  const dir = await mkdtemp(join(tmpdir(), "lintlane-merge-"));
  try {
    await Promise.all([
      writeFile(join(dir, "ours"), ours),
      writeFile(join(dir, "base"), base),
      writeFile(join(dir, "theirs"), theirs),
    ]);
    const result = await runProcess(
      "git",
      ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", "ours", "base", "theirs"],
      { cwd: dir },
    );
    // Exit code = number of conflicts (0 = clean); anything else is an error.
    return result.code === 0
      ? { merged: result.stdout, conflict: false }
      : { merged: null, conflict: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function readIfExists(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Put files back the way they were before the run. A file is only overwritten
 * if it still holds what *we* left in it (the staged content or Biome's output);
 * if the developer saved something else in the meantime, it is left alone and
 * reported, and the backup is kept.
 */
function restoreOriginals(cwd, entries) {
  const kept = [];
  for (const entry of entries) {
    const original = entry.kind === "partial" ? entry.working : entry.blob;
    const abs = join(cwd, entry.path);
    const current = readIfExists(abs);
    if (current?.equals(original)) continue;
    const ours = [entry.blob, entry.after].filter(Boolean);
    if (current === null || ours.some((buffer) => buffer.equals(current))) {
      writeFileSync(abs, original);
    } else {
      kept.push(entry.path);
    }
  }
  return kept;
}

/**
 * Check and fix the staged files. Resolves with { ok, changed, skipped, warnings }.
 * `biome` is an argv prefix (see resolveBiome). `log` receives user-facing text.
 */
export async function runStagedChecks({ cwd, biome, log = {}, colors = "off" }) {
  const say = log.out ?? (() => {});
  const complain = log.err ?? (() => {});
  const result = { ok: true, changed: [], skipped: [], warnings: [] };

  const staged = await listStagedFiles(cwd);
  if (staged.length === 0) return result;

  const backupDir = await backupDirFor(cwd);
  if (existsSync(backupDir) && readdirSync(backupDir).length > 0) {
    throw new StaleBackupError(backupDir);
  }

  // 1. Snapshot the exact staged content and the working copy of every file.
  const entries = [];
  await mapLimit(staged, CONCURRENCY, async (file) => {
    const blob = await git(["cat-file", "blob", file.sha], { cwd });
    const working = readIfExists(join(cwd, file.path));
    if (working === null) {
      result.skipped.push(file.path); // deleted in the working tree: leave the index alone
      return;
    }
    const kind = working.equals(blob) ? "clean" : "partial";
    entries.push({ ...file, blob, working, kind, after: null });
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (entries.length === 0) return result;

  // 2. Make the working copy of partially staged files equal the staged content,
  //    after saving the developer's version somewhere durable.
  const partial = entries.filter((entry) => entry.kind === "partial");
  if (partial.length > 0) {
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          files: partial.map((entry, i) => ({ id: i, path: entry.path, blob: entry.sha })),
        },
        null,
        2,
      ),
    );
    for (const [i, entry] of partial.entries()) {
      writeFileSync(join(backupDir, String(i)), entry.working);
    }
  }

  let finished = false;
  const onSignal = (signal) => {
    if (finished) return;
    restoreOriginals(cwd, entries);
    rmSync(backupDir, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);

  try {
    for (const entry of partial) writeFileSync(join(cwd, entry.path), entry.blob);

    // 3. Run Biome on the real files, exactly as the old hook did.
    const paths = entries.map((entry) =>
      entry.path.startsWith("-") ? `./${entry.path}` : entry.path,
    );
    let biomeOk = true;
    for (let i = 0; i < paths.length; i += BIOME_CHUNK) {
      const run = await runProcess(
        biome[0],
        [
          ...biome.slice(1),
          "check",
          "--write",
          "--no-errors-on-unmatched",
          "--files-ignore-unknown=true",
          `--colors=${colors}`,
          ...paths.slice(i, i + BIOME_CHUNK),
        ],
        { cwd },
      );
      if (run.error) {
        complain(`lintlane: couldn't run Biome: ${run.error.message}\n`);
        biomeOk = false;
      } else {
        if (run.stdout.length) say(run.stdout.toString());
        if (run.stderr.length) complain(run.stderr.toString());
        if (run.code !== 0) biomeOk = false;
      }
    }
    for (const entry of entries) entry.after = readIfExists(join(cwd, entry.path));

    // 4. Failure: put everything back. The index was never touched.
    if (!biomeOk) {
      const kept = restoreOriginals(cwd, entries);
      result.ok = false;
      result.warnings.push(
        ...kept.map((path) => `${path} changed while the hook ran; left as saved`),
      );
      if (kept.length === 0) rmSync(backupDir, { recursive: true, force: true });
      return result;
    }

    // 5. Success: record Biome's changes in the index, entry by entry...
    const changed = entries.filter((entry) => entry.after && !entry.after.equals(entry.blob));
    if (changed.length > 0) {
      const shas = await mapLimit(changed, CONCURRENCY, async (entry) =>
        (await git(["hash-object", "-w", "--no-filters", "--stdin"], { cwd, input: entry.after }))
          .toString()
          .trim(),
      );
      const records = changed
        .map((entry, i) => `${entry.mode} ${shas[i]} 0\t${entry.path}\0`)
        .join("");
      await git(["update-index", "-z", "--index-info"], { cwd, input: Buffer.from(records) });
      result.changed = changed.map((entry) => entry.path);
    }

    // ...and bring the developer's working copy of partially staged files up to
    // date without losing their unstaged edits.
    const kept = [];
    for (const entry of partial) {
      const abs = join(cwd, entry.path);
      const current = readIfExists(abs);
      if (current === null || !(entry.after ?? entry.blob).equals(current)) {
        kept.push(entry.path); // changed under us; never overwrite
        continue;
      }
      let next = entry.working;
      if (entry.after && !entry.after.equals(entry.blob)) {
        const { merged, conflict } = await mergeThreeWay({
          base: entry.blob,
          ours: entry.working,
          theirs: entry.after,
        });
        if (!conflict) next = merged;
        else
          result.warnings.push(
            `${entry.path}: your unstaged edits overlap the formatting changes; left as you wrote it`,
          );
      }
      writeFileSync(abs, next);
    }
    result.warnings.push(
      ...kept.map((path) => `${path} changed while the hook ran; left as saved`),
    );
    if (kept.length === 0) rmSync(backupDir, { recursive: true, force: true });
    return result;
  } catch (error) {
    restoreOriginals(cwd, entries);
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  } finally {
    finished = true;
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
}

/**
 * Recovery for a run that was killed before it could clean up (SIGKILL, power
 * loss): put the saved working copies back, unless the file changed since.
 */
export async function restoreFromBackup(cwd) {
  const backupDir = await backupDirFor(cwd);
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) return { restored: [], kept: [], found: false };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const restored = [];
  const kept = [];
  for (const file of manifest.files) {
    const abs = join(cwd, file.path);
    const saved = readFileSync(join(backupDir, String(file.id)));
    const blob = await git(["cat-file", "blob", file.blob], { cwd });
    const current = readIfExists(abs);
    // Still holding the staged content we swapped in (or already gone): safe to restore.
    if (current === null || current.equals(blob) || current.equals(saved)) {
      writeFileSync(abs, saved);
      restored.push(file.path);
    } else {
      kept.push(file.path);
    }
  }
  if (kept.length === 0) rmSync(backupDir, { recursive: true, force: true });
  return { restored, kept, found: true, backupDir };
}
