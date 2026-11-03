// Integration tests for the pre-commit hook, against real temporary git repos.
// The hook must format what is staged and NEVER stage, discard or rewrite
// anything the developer didn't stage.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BIOME_CONFIG,
  cleanEnv,
  commit,
  committed,
  createRepo,
  git,
  gitOut,
  KIT_BIOME,
  lastCommitFiles,
  PRE_COMMIT,
  read,
  runHook,
  snapshot,
  staged,
  write,
} from "./helpers.mjs";

const fixture = (name) => fileURLToPath(new URL(`../test-fixtures/${name}`, import.meta.url));

const FORMATTED = "export const a = 1;\n\nexport const b = 2;\n\nexport const c = 3;\n";
// Line 1 staged unformatted; line 5 edited (also unformatted) but NOT staged.
const STAGED_TEXT = "export const a   =   10\n\nexport const b = 2;\n\nexport const c = 3;\n";
const WORKING_TEXT = "export const a   =   10\n\nexport const b = 2;\n\nexport const c   =   30\n";
const STAGED_FORMATTED = "export const a = 10;\n\nexport const b = 2;\n\nexport const c = 3;\n";
const WORKING_MERGED = "export const a = 10;\n\nexport const b = 2;\n\nexport const c   =   30\n";

/** a.js committed, then staged with STAGED_TEXT and further edited to WORKING_TEXT. */
function partiallyStagedRepo(extraFiles = {}) {
  const dir = createRepo({ files: { "a.js": FORMATTED, ...extraFiles } });
  write(dir, "a.js", STAGED_TEXT);
  gitOut(dir, "add", "a.js");
  write(dir, "a.js", WORKING_TEXT);
  return dir;
}

const backupDir = (dir) => join(dir, ".git", "lintlane-backup");

describe("pre-commit: staged files are formatted", () => {
  it("fully staged modification: commits the formatted content and leaves the tree clean", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", STAGED_TEXT);
    gitOut(dir, "add", "a.js");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), STAGED_FORMATTED);
    assert.equal(read(dir, "a.js"), STAGED_FORMATTED);
    assert.equal(gitOut(dir, "status", "--porcelain"), "");
  });

  it("formats several staged files of different types", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED, "data.json": '{ "a": 1 }\n' } });
    write(dir, "a.js", "export const a   =   2\n");
    write(dir, "data.json", '{"a":2,"b":[1,2]}');
    write(dir, "styles.css", "a{color:red}\n");
    gitOut(dir, "add", "a.js", "data.json", "styles.css");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), "export const a = 2;\n");
    assert.equal(committed(dir, "data.json"), '{ "a": 2, "b": [1, 2] }\n');
    assert.equal(gitOut(dir, "status", "--porcelain"), "");
  });

  it("applies Biome's safe lint fixes, not just formatting", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(
      dir,
      "a.js",
      "export const a = { b: 1 };\nconst x = a.b === true ? 1 : 2;\nexport { x };\n",
    );
    gitOut(dir, "add", "a.js");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(committed(dir, "a.js"), /^export const a = \{ b: 1 \};\n/);
    assert.equal(read(dir, "a.js"), committed(dir, "a.js"));
  });

  it("does not block on warnings", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", "const unused = 1;\nexport const a = 1;\n"); // noUnusedVariables is a warning
    gitOut(dir, "add", "a.js");
    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
  });
});

describe("pre-commit: partially staged files", () => {
  it("formats only the staged content and keeps the unstaged edit byte for byte", () => {
    const dir = partiallyStagedRepo();
    const before = snapshot(dir);

    const hook = runHook(dir);
    assert.equal(hook.status, 0, hook.stderr);

    // Index: a.js now holds the formatted STAGED content; the unstaged edit is not in it.
    assert.equal(staged(dir, "a.js"), STAGED_FORMATTED);
    // Working tree: Biome's change to the staged line is merged in, the unstaged line is untouched.
    assert.equal(read(dir, "a.js"), WORKING_MERGED);
    // Nothing else moved: same HEAD, same set of files, still partially staged.
    const after = snapshot(dir);
    assert.equal(after.head, before.head);
    assert.deepEqual(Object.keys(after.files), Object.keys(before.files));
    assert.equal(gitOut(dir, "status", "--porcelain"), "MM a.js\n");
    assert.equal(existsSync(backupDir(dir)), false, "no backup should be left behind");
  });

  it("a real commit contains only the staged change; the unstaged edit stays unstaged", () => {
    const dir = partiallyStagedRepo();

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      committed(dir, "a.js"),
      STAGED_FORMATTED,
      "the unstaged edit must not be committed",
    );
    assert.equal(read(dir, "a.js"), WORKING_MERGED);

    const unstaged = gitOut(dir, "diff");
    assert.match(unstaged, /^-export const c = 3;$/m);
    assert.match(unstaged, /^\+export const c {3}= {3}30$/m);
    assert.equal(gitOut(dir, "diff", "--cached", "--name-only"), "", "nothing may be left staged");
  });

  it("leaves the working copy exactly as written when the unstaged edit overlaps a formatting change", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", "export const a   =   10\n\nexport const b = 2;\n\nexport const c = 3;\n");
    gitOut(dir, "add", "a.js");
    const mine = "export const a   =   11\n\nexport const b = 2;\n\nexport const c = 3;\n"; // same line, different edit
    write(dir, "a.js", mine);

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), STAGED_FORMATTED);
    assert.equal(read(dir, "a.js"), mine, "an overlapping unstaged edit must never be rewritten");
    assert.match(gitOut(dir, "diff"), /\+export const a {3}= {3}11/);
  });

  it("does nothing, and leaves no trace, when Biome has nothing to change", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", FORMATTED.replace("b = 2", "b = 20"));
    gitOut(dir, "add", "a.js");
    write(dir, "a.js", FORMATTED.replace("b = 2", "b = 20").replace("c = 3", "c = 30"));
    const before = snapshot(dir);

    const hook = runHook(dir);
    assert.equal(hook.status, 0, hook.stderr);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(existsSync(backupDir(dir)), false);
  });

  it("merges formatting into a file with many staged hunks and an unstaged edit in the middle", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`);
    const dir = createRepo({ files: { "big.js": `${lines.join("\n")}\n` } });
    const messy = lines.map((line, i) =>
      i % 10 === 0 ? line.replace(" = ", "   =   ").slice(0, -1) : line,
    );
    write(dir, "big.js", `${messy.join("\n")}\n`);
    gitOut(dir, "add", "big.js");
    const mine = [...messy];
    mine[15] = "export const v15   =   1500";
    write(dir, "big.js", `${mine.join("\n")}\n`);

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "big.js"), `${lines.join("\n")}\n`);
    const expectedWorking = [...lines];
    expectedWorking[15] = "export const v15   =   1500";
    assert.equal(read(dir, "big.js"), `${expectedWorking.join("\n")}\n`);
  });
});

describe("pre-commit: nothing outside the staged set is touched", () => {
  it("never stages or rewrites unstaged edits to other tracked files", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED, "b.js": FORMATTED } });
    write(dir, "a.js", STAGED_TEXT);
    gitOut(dir, "add", "a.js");
    const unstagedB = "export const b   =   99\n"; // unformatted on purpose
    write(dir, "b.js", unstagedB);

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(lastCommitFiles(dir), ["a.js"]);
    assert.equal(read(dir, "b.js"), unstagedB, "the other file must keep its exact bytes");
    assert.equal(committed(dir, "b.js"), FORMATTED);
    assert.equal(gitOut(dir, "status", "--porcelain"), " M b.js\n");
  });

  it("never stages or touches untracked files", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", STAGED_TEXT);
    gitOut(dir, "add", "a.js");
    write(dir, "new.js", "export const n   =   1\n");
    write(dir, "notes.txt", "scratch\n");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(lastCommitFiles(dir), ["a.js"]);
    assert.equal(read(dir, "new.js"), "export const n   =   1\n");
    assert.equal(read(dir, "notes.txt"), "scratch\n");
    assert.match(gitOut(dir, "status", "--porcelain"), /^\?\? new\.js$/m);
  });

  it("does not use git add or update-index --again (the hook source and template are clean)", () => {
    for (const file of ["bin/staged.mjs", "bin/pre-commit.mjs", "templates/pre-commit"]) {
      const source = readFileSync(
        join(fileURLToPath(new URL("..", import.meta.url)), file),
        "utf8",
      );
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      assert.doesNotMatch(
        code,
        /update-index["',\s]+--again/,
        `${file} must not re-stage with --again`,
      );
      assert.doesNotMatch(
        code,
        /["']add["']\s*,\s*["'](\.|-A|--all)["']/,
        `${file} must not run git add . / -A`,
      );
    }
  });

  it("documents the bug being fixed: the old hook DID stage unstaged hunks", () => {
    const config = {
      ...BIOME_CONFIG,
      vcs: { enabled: true, clientKind: "git", useIgnoreFile: true },
    };
    const dir = createRepo({
      files: { "a.js": FORMATTED, ".gitignore": "node_modules\n" },
      config,
      hook: "none",
    });
    write(dir, "a.js", STAGED_TEXT);
    gitOut(dir, "add", "a.js");
    write(dir, "a.js", WORKING_TEXT);

    // The old hook, verbatim.
    spawnSync(
      KIT_BIOME,
      ["check", "--write", "--staged", "--no-errors-on-unmatched", "--files-ignore-unknown=true"],
      {
        cwd: dir,
        env: cleanEnv(),
      },
    );
    gitOut(dir, "update-index", "--again");

    // The unstaged `c = 30` edit is now in the index (formatted, too): it would be
    // committed even though the developer never staged it.
    assert.match(
      staged(dir, "a.js"),
      /const c = 30;/,
      "the old hook staged an edit the developer never staged",
    );
  });
});

describe("pre-commit: Biome failures block the commit and change nothing", () => {
  function assertUntouched(dir, before, result) {
    assert.notEqual(result.status, 0, "the commit must be blocked");
    assert.deepEqual(
      snapshot(dir),
      before,
      "index, HEAD and working tree must be exactly as before",
    );
    assert.equal(existsSync(backupDir(dir)), false, "no backup may be left behind");
  }

  it("blocks on a lint error and leaves the index and working tree byte for byte unchanged", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", "debugger;\nexport const a   =   2\n");
    gitOut(dir, "add", "a.js");
    const before = snapshot(dir);

    const result = commit(dir);
    assertUntouched(dir, before, result);
    assert.match(result.stderr + result.stdout, /noDebugger/);
  });

  it("blocks on a syntax error", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", "export const = ;\n");
    gitOut(dir, "add", "a.js");
    const before = snapshot(dir);
    assertUntouched(dir, before, commit(dir));
  });

  it("is all-or-nothing: a fixable file is not modified when another staged file fails", () => {
    const dir = createRepo({ files: { "good.js": FORMATTED, "bad.js": FORMATTED } });
    write(dir, "good.js", "export const good   =   1\n"); // fixable
    write(dir, "bad.js", "debugger;\n"); // not fixable
    gitOut(dir, "add", "good.js", "bad.js");
    const before = snapshot(dir);

    assertUntouched(dir, before, commit(dir));
    assert.equal(read(dir, "good.js"), "export const good   =   1\n");
    assert.equal(staged(dir, "good.js"), "export const good   =   1\n");
  });

  it("restores a partially staged file exactly when the commit is blocked", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", "debugger;\nexport const a   =   10\n");
    gitOut(dir, "add", "a.js");
    write(dir, "a.js", "debugger;\nexport const a   =   10\nexport const extra   =   5\n"); // unstaged addition
    const before = snapshot(dir);

    assertUntouched(dir, before, commit(dir));
    assert.equal(
      read(dir, "a.js"),
      "debugger;\nexport const a   =   10\nexport const extra   =   5\n",
    );
  });
});

describe("pre-commit: file names and kinds", () => {
  it("handles spaces, non-ASCII characters and a leading dash in file names", () => {
    const names = ["my file.js", "dir with space/ünï côdé.js", "-dash.js"];
    const dir = createRepo({ files: { "keep.js": FORMATTED } });
    for (const name of names) write(dir, name, "export const x   =   1\n");
    gitOut(dir, "add", "--", ...names);

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    for (const name of names) {
      assert.equal(committed(dir, name), "export const x = 1;\n", name);
      assert.equal(read(dir, name), "export const x = 1;\n", name);
    }
  });

  it("handles a partially staged file with spaces in its name", () => {
    const dir = createRepo({ files: { "my file.js": FORMATTED } });
    write(dir, "my file.js", STAGED_TEXT);
    gitOut(dir, "add", "my file.js");
    write(dir, "my file.js", WORKING_TEXT);

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "my file.js"), STAGED_FORMATTED);
    assert.equal(read(dir, "my file.js"), WORKING_MERGED);
  });

  it("commits a staged deletion without touching anything else", () => {
    const dir = createRepo({ files: { "old.js": FORMATTED, "a.js": FORMATTED } });
    gitOut(dir, "rm", "-q", "old.js");
    write(dir, "a.js", "export const a   =   2\n");
    gitOut(dir, "add", "a.js");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(dir, "cat-file", "-e", "HEAD:old.js").status !== 0,
      true,
      "old.js is deleted in HEAD",
    );
    assert.equal(committed(dir, "a.js"), "export const a = 2;\n");
    assert.equal(gitOut(dir, "status", "--porcelain"), "");
  });

  it("formats a renamed file at its new path", () => {
    const dir = createRepo({ files: { "old name.js": FORMATTED } });
    gitOut(dir, "mv", "old name.js", "new name.js");
    write(dir, "new name.js", "export const a   =   1\n");
    gitOut(dir, "add", "new name.js");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "new name.js"), "export const a = 1;\n");
    assert.equal(git(dir, "cat-file", "-e", "HEAD:old name.js").status !== 0, true);
  });

  it("leaves a file deleted in the working tree alone (its staged version is committed as is)", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", "export const a   =   2\n");
    gitOut(dir, "add", "a.js");
    rmSync(join(dir, "a.js"));
    const before = snapshot(dir);

    const hook = runHook(dir);
    assert.equal(hook.status, 0, hook.stderr);
    assert.deepEqual(
      snapshot(dir),
      before,
      "the file must not be recreated and the index must not change",
    );
  });

  it("keeps the executable bit and ignores symlinks, unknown types and Biome-ignored paths", () => {
    const config = { ...BIOME_CONFIG, files: { includes: ["**", "!generated"] } };
    const dir = createRepo({ files: { "keep.js": FORMATTED }, config });
    write(dir, "run.js", "export const run   =   1\n");
    chmodSync(join(dir, "run.js"), 0o755);
    write(dir, "notes.txt", "hello   world\n");
    write(dir, "generated/out.js", "export const g   =   1\n");
    symlinkSync("keep.js", join(dir, "link.js"));
    gitOut(dir, "add", "-A");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "run.js"), "export const run = 1;\n");
    assert.match(gitOut(dir, "ls-files", "-s", "run.js"), /^100755 /, "executable bit preserved");
    assert.match(gitOut(dir, "ls-files", "-s", "link.js"), /^120000 /, "symlink stays a symlink");
    assert.equal(
      committed(dir, "notes.txt"),
      "hello   world\n",
      "unknown file types are left alone",
    );
    assert.equal(
      committed(dir, "generated/out.js"),
      "export const g   =   1\n",
      "ignored paths are left alone",
    );
  });
});

describe("pre-commit: other commit flows", () => {
  it("succeeds quickly with nothing staged (--allow-empty)", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED } });
    write(dir, "a.js", "export const a   =   2\n"); // unstaged only
    const before = snapshot(dir);

    const result = commit(dir, "chore: empty", "--allow-empty");
    assert.equal(result.status, 0, result.stderr);
    const after = snapshot(dir);
    assert.deepEqual(after.files, before.files);
    assert.equal(after.index, before.index);
    assert.equal(runHook(dir).stdout, "");
  });

  it("works with `git commit -a` (git hands the hook a temporary index)", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED, "b.js": FORMATTED } });
    write(dir, "a.js", "export const a   =   2\n");
    write(dir, "b.js", "export const b   =   3\n");
    write(dir, "untracked.js", "export const u   =   1\n");

    const result = commit(dir, "feat: all", "-a");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), "export const a = 2;\n");
    assert.equal(committed(dir, "b.js"), "export const b = 3;\n");
    assert.equal(read(dir, "a.js"), "export const a = 2;\n");
    assert.equal(read(dir, "untracked.js"), "export const u   =   1\n");
    assert.deepEqual(lastCommitFiles(dir).sort(), ["a.js", "b.js"]);
  });

  it("works on the very first commit of a repository", () => {
    const dir = createRepo({ hook: "direct" });
    gitOut(dir, "update-ref", "-d", "HEAD");
    gitOut(dir, "reset", "-q");
    write(dir, "first.js", "export const first   =   1\n");
    gitOut(dir, "add", "first.js");
    const result = commit(dir, "feat: first");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "first.js"), "export const first = 1;\n");
  });

  it("handles more files than fit in one Biome invocation", () => {
    const dir = createRepo({ files: { "keep.js": FORMATTED } });
    const names = Array.from({ length: 230 }, (_, i) => `many/file-${i}.js`);
    for (const name of names) write(dir, name, "export const x   =   1\n");
    gitOut(dir, "add", "many");

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    for (const name of [names[0], names[100], names[229]]) {
      assert.equal(committed(dir, name), "export const x = 1;\n");
    }
    assert.equal(gitOut(dir, "status", "--porcelain"), "");
  });

  it("works through the shipped .husky/pre-commit template (and warns, not fails, if lintlane is missing)", () => {
    const dir = createRepo({ files: { "a.js": FORMATTED }, hook: "template" });
    write(dir, "a.js", STAGED_TEXT);
    gitOut(dir, "add", "a.js");
    write(dir, "a.js", WORKING_TEXT);

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), STAGED_FORMATTED);
    assert.equal(read(dir, "a.js"), WORKING_MERGED);

    rmSync(join(dir, "node_modules", "lintlane"));
    write(dir, "b.js", "export const b   =   1\n");
    gitOut(dir, "add", "b.js");
    const skipped = commit(dir, "feat: no lintlane");
    assert.equal(skipped.status, 0);
    assert.match(skipped.stderr, /node_modules\/lintlane not found/);
  });
});

describe("pre-commit: interruption safety", () => {
  const killer = fixture("kill-parent.mjs");
  const sleeper = fixture("sleep.mjs");
  const harness = fixture("run-staged.mjs");

  const exited = (child) =>
    new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const waitFor = async (condition, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (condition()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out");
  };

  it("recovers the developer's working copy after a hard kill (SIGKILL) via --restore", async () => {
    const dir = partiallyStagedRepo();
    const indexBefore = snapshot(dir).index;

    const child = spawn(process.execPath, [harness, dir, process.execPath, killer], {
      env: cleanEnv(),
      stdio: "ignore",
    });
    assert.equal((await exited(child)).signal, "SIGKILL");

    // The crash left the staged content in the working file and the user's version in a backup.
    assert.equal(read(dir, "a.js"), STAGED_TEXT);
    assert.equal(existsSync(join(backupDir(dir), "manifest.json")), true);

    // The next hook run refuses to continue, and explains how to recover.
    const blocked = runHook(dir);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /interrupted/);
    assert.match(blocked.stderr, /--restore/);
    assert.equal(read(dir, "a.js"), STAGED_TEXT, "a blocked run must not touch anything");

    const restored = spawnSync(process.execPath, [PRE_COMMIT, "--restore"], {
      cwd: dir,
      env: cleanEnv(),
      encoding: "utf8",
    });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(read(dir, "a.js"), WORKING_TEXT, "the developer's exact content is back");
    assert.equal(snapshot(dir).index, indexBefore, "the index was never touched");
    assert.equal(existsSync(backupDir(dir)), false);

    const result = commit(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), STAGED_FORMATTED);
  });

  it("restores everything when interrupted with Ctrl+C (SIGINT)", async () => {
    const dir = partiallyStagedRepo();
    const before = snapshot(dir);

    const child = spawn(process.execPath, [harness, dir, process.execPath, sleeper], {
      env: cleanEnv(),
      stdio: "ignore",
      detached: true, // own process group, like a terminal's foreground job
    });
    const done = exited(child);
    await waitFor(
      () =>
        existsSync(join(backupDir(dir), "manifest.json")) &&
        statSync(join(dir, "a.js")).size === Buffer.byteLength(STAGED_TEXT),
    );
    process.kill(-child.pid, "SIGINT");

    assert.equal((await done).code, 130);
    assert.deepEqual(
      snapshot(dir),
      before,
      "index, HEAD and the working tree are exactly as before",
    );
    assert.equal(existsSync(backupDir(dir)), false);
  });
});
