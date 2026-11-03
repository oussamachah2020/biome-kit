#!/usr/bin/env node
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { binPath, resolveBiome, runInherit, runProcess } from "./proc.mjs";
import {
  detectPackageManager,
  detectPreset,
  hasUnsafeRestaging,
  installCommand,
  isLegacyPreCommit,
  PRESET_PATHS,
  renderWorkflow,
  runnerCommand,
} from "./project.mjs";

const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const KIT_PKG = await readJson(join(KIT_DIR, "package.json"));
const KIT_NAME = KIT_PKG.name;
const KIT_VERSION = KIT_PKG.version;
const RUNNER = runnerCommand();

const BIOME_SUBCOMMANDS = {
  check: (paths) => ["check", ...paths],
  "check:fix": (paths) => ["check", "--write", ...paths],
  ci: (paths) => ["ci", "--reporter=github", ...paths],
};

const HELP = `Usage: ${RUNNER} ${KIT_NAME} <command> [options]

Commands:
  init [options]   Set up Biome, scripts, hooks, and CI in the current project
  check [paths]     Run biome check (defaults to .)
  check:fix [paths] Run biome check --write (defaults to .)
  ci [paths]        Run biome ci --reporter=github (defaults to .)
  commit [options]  Guided commit (alias: c): asks step by step, then commits as a
                    Conventional Commit. Flags: --dry-run, --retry, --no-retry,
                    --write-message-to-file <f>, -l <n>; git flags go after --
  check-commit      Validate commit messages (--message, --commit-msg-file,
                    --rev-range, -d, --allow-abort, --allowed-prefixes, -l)
  ui [options]      Open the local dashboard: run checks, review errors and
                    proposed fixes as a diff, apply fixes per file

ui options:
  --port <n>                   Port to listen on (default: 4321)
  --no-open                    Don't open the browser automatically

init options:
  --preset <base|strict|next>  Which preset to extend (default: auto-detected)
  --no-hooks                   Skip husky + pre-commit hook setup
  --no-commit-lint             Skip the commit-message hooks (commit-msg, prepare-commit-msg, pre-push)
  --no-ci                      Skip the GitHub Actions workflow
  --skip-install                Print install commands instead of running them
  -h, --help                   Show this help

Without --preset, init reads your package.json dependencies and picks for
you: Next.js -> "next" preset; React, TanStack Start, React Router
(framework mode), or Remix -> "base" preset (they're all React under the
hood, and only Next.js has its own Biome lint domain). "strict" is never
auto-selected — pass --preset strict explicitly when you want it.

check / check:fix / ci run the Biome binary already installed in this
project's node_modules — you never need to call biome yourself. The
package manager (npm, pnpm, yarn, or bun) used by \`init\` is detected from
the "packageManager" field in package.json, then from whichever lockfile is
present, then from the tool you launched lintlane with (npx, pnpm dlx, yarn
dlx, bunx). npm is used when none of those apply.

After \`init\` the \`lintlane\` command is installed in your project, for
example: \`npx lintlane check\`, \`pnpm exec lintlane check\`,
\`yarn lintlane check\`, \`bunx lintlane check\`.
`;

function fail(message) {
  console.error(`✘ ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`✔ ${message}`);
}

function warn(message) {
  console.log(`! ${message}`);
}

// Everything after a bare "--" belongs to the subcommand (e.g. `commit -- -a -S`
// hands "-a -S" to git commit), so it never reaches our own option parsing.
const rawArgs = process.argv.slice(2);
const doubleDash = rawArgs.indexOf("--");
const ownArgs = doubleDash < 0 ? rawArgs : rawArgs.slice(0, doubleDash);
const passthroughArgs = doubleDash < 0 ? [] : rawArgs.slice(doubleDash + 1);

const { values, positionals } = parseArgs({
  args: ownArgs,
  options: {
    preset: { type: "string" },
    "no-hooks": { type: "boolean", default: false },
    "no-ci": { type: "boolean", default: false },
    "no-commit-lint": { type: "boolean", default: false },
    "skip-install": { type: "boolean", default: false },
    port: { type: "string" },
    "no-open": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0] ?? "init";
const cwd = process.cwd();
const commandArgs = ownArgs.slice(ownArgs.indexOf(command) + 1);

// `commit -h` and `check-commit -h` show their own help; everything else the main one.
if (values.help && !["commit", "c", "check-commit"].includes(command)) {
  console.log(HELP);
  process.exit(0);
}

if (command in BIOME_SUBCOMMANDS) {
  const biome = resolveBiome(cwd);
  if (!biome) {
    fail(`Biome isn't installed in this project. Run: ${RUNNER} ${KIT_NAME} init`);
  }
  const extraPaths = positionals.slice(1);
  const biomeArgs = BIOME_SUBCOMMANDS[command](extraPaths.length ? extraPaths : ["."]);
  process.exit(await runInherit(biome[0], [...biome.slice(1), ...biomeArgs], { cwd }));
}

if (command === "commit" || command === "c") {
  const { runCommit } = await import("./commit-cli.mjs");
  process.exit(await runCommit({ argv: commandArgs, gitArgs: passthroughArgs, cwd }));
}

if (command === "check-commit") {
  const { main } = await import("./check-commit.mjs");
  process.exit(await main(commandArgs, cwd));
}

if (command === "ui") {
  const biome = resolveBiome(cwd);
  if (!biome) {
    fail(`Biome isn't installed in this project. Run: ${RUNNER} ${KIT_NAME} init`);
  }
  const { startUi } = await import("./ui-server.mjs");
  const uiPkgPath = join(cwd, "package.json");
  const uiPkg = existsSync(uiPkgPath) ? await readJson(uiPkgPath) : {};
  try {
    await startUi({
      cwd,
      biome,
      pkg: uiPkg,
      pmName: detectPackageManager(cwd, uiPkg).name,
      kitDir: KIT_DIR,
      port: values.port === undefined ? 4321 : Number(values.port),
      open: !values["no-open"],
    });
  } catch (error) {
    fail(error.message);
  }
  await new Promise(() => {});
}

if (command !== "init") {
  fail(
    `Unknown command "${command}". Usage: ${RUNNER} ${KIT_NAME} <init|check|check:fix|ci|commit|check-commit|ui> [options]`,
  );
}

if (values.preset !== undefined && !(values.preset in PRESET_PATHS)) {
  fail(
    `Invalid preset "${values.preset}". Valid presets: ${Object.keys(PRESET_PATHS).join(", ")}.`,
  );
}

const pkgPath = join(cwd, "package.json");
if (!existsSync(pkgPath)) {
  fail("No package.json found in the current directory.");
}

let pkg = await readJson(pkgPath);
const { name: pmName, source: pmSource } = detectPackageManager(cwd, pkg);
ok(`Detected package manager: ${pmName} (${pmSource})`);

let preset = values.preset;
if (preset === undefined) {
  const detected = detectPreset(pkg);
  preset = detected.preset;
  if (detected.label) {
    ok(`Detected ${detected.label} — using preset "${preset}"`);
  } else {
    warn(`No known framework detected — using preset "${preset}" (pass --preset to choose)`);
  }
}

// LINTLANE_INSTALL_SPEC lets you install lintlane from somewhere other than the
// registry (a tarball from `npm pack`, a local folder) when testing a build.
const kitSpec = process.env.LINTLANE_INSTALL_SPEC || `${KIT_NAME}@${KIT_VERSION}`;
const devPackages = ["@biomejs/biome", kitSpec];
if (!values["no-hooks"]) devPackages.push("husky");
const installArgv = installCommand(pmName, devPackages);

if (values["skip-install"]) {
  warn(`Skipped install. Run: ${installArgv.join(" ")}`);
} else {
  const install = await runProcess(installArgv[0], installArgv.slice(1), { cwd });
  if (install.code !== 0) {
    const reason =
      install.error?.code === "ENOENT"
        ? `"${installArgv[0]}" was not found. Install it, or run again with --skip-install and install the packages yourself:\n  ${installArgv.join(" ")}`
        : (install.stderr.toString().trim() || install.stdout.toString().trim())
            .split("\n")
            .slice(-8)
            .join("\n");
    fail(`Install failed (${installArgv.join(" ")}):\n${reason}`);
  }
  ok(`Installed ${devPackages.join(", ")}`);
  // The install just rewrote package.json (devDependencies). Re-read it, or the
  // scripts we add below would be written over a stale copy and erase those entries.
  pkg = await readJson(pkgPath);
}

const biomeJsonPath = join(cwd, "biome.json");
const biomeJsoncPath = join(cwd, "biome.jsonc");
const extendsSpecifier = `${KIT_NAME}/${PRESET_PATHS[preset]}`;

if (existsSync(biomeJsonPath) || existsSync(biomeJsoncPath)) {
  warn(`biome.json already exists — add this to its "extends": "${extendsSpecifier}"`);
} else {
  const config = {
    $schema: "./node_modules/@biomejs/biome/configuration_schema.json",
    extends: [extendsSpecifier],
  };
  if (preset === "next") {
    config.files = { includes: ["**", "!**/.next", "!**/out", "!**/next-env.d.ts"] };
  }
  await writeFile(biomeJsonPath, `${JSON.stringify(config, null, 2)}\n`);
  ok(`Wrote biome.json (extends ${extendsSpecifier})`);
}

pkg.scripts ??= {};
let pkgChanged = false;

if (!pkg.scripts.check) {
  pkg.scripts.check = "biome check .";
  pkgChanged = true;
  ok('Added script "check"');
} else {
  warn('Script "check" already exists — left untouched');
}

if (!pkg.scripts["check:fix"]) {
  pkg.scripts["check:fix"] = "biome check --write .";
  pkgChanged = true;
  ok('Added script "check:fix"');
} else {
  warn('Script "check:fix" already exists — left untouched');
}

if (!values["no-hooks"]) {
  if (!pkg.scripts.prepare) {
    pkg.scripts.prepare = "husky";
    pkgChanged = true;
    ok('Added script "prepare"');
  } else if (!pkg.scripts.prepare.includes("husky")) {
    pkg.scripts.prepare = `${pkg.scripts.prepare} && husky`;
    pkgChanged = true;
    ok('Appended husky to existing "prepare" script');
  } else {
    warn('Script "prepare" already runs husky — left untouched');
  }
}

if (pkgChanged) {
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

if (!values["no-hooks"]) {
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) {
    warn("No .git directory found — skipping husky hook setup");
  } else {
    const huskyDir = join(cwd, ".husky");
    const hooks = ["pre-commit"];
    if (!values["no-commit-lint"]) hooks.push("commit-msg", "prepare-commit-msg", "pre-push");
    let wroteHook = false;

    for (const hook of hooks) {
      const hookPath = join(huskyDir, hook);
      const template = await readFile(join(KIT_DIR, "templates", hook), "utf8");
      if (existsSync(hookPath)) {
        const existing = await readFile(hookPath, "utf8");
        if (hook === "pre-commit" && isLegacyPreCommit(existing)) {
          // The pre-2.6 hook re-staged files with `git update-index --again`, which also
          // stages unstaged hunks of partially staged files. It's ours and untouched, so replace it.
          await writeFile(hookPath, template);
          await chmod(hookPath, 0o755);
          ok("Replaced .husky/pre-commit (the old one could stage changes you hadn't staged)");
          wroteHook = true;
        } else if (hook === "pre-commit" && hasUnsafeRestaging(existing)) {
          warn(
            ".husky/pre-commit runs `git update-index --again`, which can stage changes you didn't stage. " +
              "Replace its contents with node_modules/lintlane/templates/pre-commit (or delete it and re-run init).",
          );
        } else {
          warn(`.husky/${hook} already exists — left untouched`);
        }
        continue;
      }
      await mkdir(huskyDir, { recursive: true });
      await writeFile(hookPath, template);
      await chmod(hookPath, 0o755);
      ok(`Wrote .husky/${hook}`);
      wroteHook = true;
    }

    if (wroteHook) {
      if (values["skip-install"]) {
        warn("Skipped: run `node_modules/.bin/husky` to finish git hooks setup");
      } else {
        const husky = binPath(cwd, "husky");
        if (existsSync(husky)) {
          const ran = await runProcess(husky, [], { cwd });
          if (ran.code === 0) ok("Ran husky");
          else warn(`husky failed: ${(ran.stderr.toString() || ran.error?.message || "").trim()}`);
        } else {
          warn(`husky binary not found at ${husky} — run it manually once installed`);
        }
      }
    }
  }
}

if (!values["no-ci"]) {
  const workflowsDir = join(cwd, ".github", "workflows");
  const ciPath = join(workflowsDir, "biome.yml");
  if (existsSync(ciPath)) {
    warn(".github/workflows/biome.yml already exists — left untouched");
  } else {
    const withCommitCheck = !values["no-commit-lint"] && !values["no-hooks"];
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(ciPath, renderWorkflow({ pmName, kitName: KIT_NAME, withCommitCheck }));
    ok("Wrote .github/workflows/biome.yml");
  }
}

console.log(`\nRun: ${pmName} run check:fix`);
