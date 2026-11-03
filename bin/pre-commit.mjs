#!/usr/bin/env node
// git `pre-commit` hook entry: formats and lints the staged files with Biome
// without ever staging anything the developer didn't stage (see staged.mjs).
//
//   node pre-commit.mjs            run the checks (what the hook does)
//   node pre-commit.mjs --restore  recover working files after an interrupted run
import { resolveBiome, runProcess } from "./proc.mjs";
import { restoreFromBackup, runStagedChecks, StaleBackupError } from "./staged.mjs";

const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);

const top = await runProcess("git", ["rev-parse", "--show-toplevel"]);
if (top.code !== 0) {
  err("lintlane: not inside a git repository.\n");
  process.exit(1);
}
const cwd = top.stdout.toString().trim();
process.chdir(cwd);

if (process.argv.includes("--restore")) {
  const { restored, kept, found, backupDir } = await restoreFromBackup(cwd);
  if (!found) out("lintlane: nothing to restore.\n");
  for (const path of restored) out(`restored ${path}\n`);
  for (const path of kept) err(`kept ${path}: it changed since the backup (see ${backupDir})\n`);
  process.exit(kept.length > 0 ? 1 : 0);
}

const biome = resolveBiome(cwd);
if (!biome) {
  err("lintlane: Biome isn't installed. Run your package manager's install, then commit again.\n");
  process.exit(1);
}

try {
  const result = await runStagedChecks({
    cwd,
    biome,
    colors: process.stderr.isTTY ? "force" : "off",
    log: { out, err },
  });
  for (const warning of result.warnings) err(`lintlane: ${warning}\n`);
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  if (error instanceof StaleBackupError) {
    err(
      `\nlintlane: an earlier run was interrupted before it could restore your files.\n` +
        `  Your working copies are saved in ${error.backupDir}\n` +
        `  Put them back with:  node node_modules/lintlane/bin/pre-commit.mjs --restore\n\n`,
    );
  } else {
    err(`lintlane: ${error.message}\n`);
  }
  process.exit(1);
}
