#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const KIT_DIR = join(import.meta.dir, "..");
const KIT_PKG = await Bun.file(join(KIT_DIR, "package.json")).json();
const KIT_NAME = KIT_PKG.name;
const KIT_VERSION = KIT_PKG.version;

const PRESET_PATHS = {
  base: "biome",
  strict: "biome/strict",
  next: "biome/next",
};

const PACKAGE_MANAGERS = {
  bun: {
    lockfile: "bun.lock",
    install: (pkgs) => ["bun", "add", "--dev", "--exact", ...pkgs],
    runCheckCi: "bunx biome ci --reporter=github .",
    setupSteps: [
      "      - uses: oven-sh/setup-bun@v2",
      "      - run: bun install --frozen-lockfile",
    ],
  },
  npm: {
    lockfile: "package-lock.json",
    install: (pkgs) => ["npm", "install", "--save-dev", "--save-exact", ...pkgs],
    runCheckCi: "npx biome ci --reporter=github .",
    setupSteps: [
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
      "          cache: npm",
      "      - run: npm ci",
    ],
  },
  pnpm: {
    lockfile: "pnpm-lock.yaml",
    install: (pkgs) => ["pnpm", "add", "--save-dev", "--save-exact", ...pkgs],
    runCheckCi: "pnpm exec biome ci --reporter=github .",
    setupSteps: [
      "      - uses: pnpm/action-setup@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
      "          cache: pnpm",
      "      - run: pnpm install --frozen-lockfile",
    ],
  },
  yarn: {
    lockfile: "yarn.lock",
    install: (pkgs) => ["yarn", "add", "--dev", "--exact", ...pkgs],
    runCheckCi: "yarn biome ci --reporter=github .",
    setupSteps: [
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
      "          cache: yarn",
      "      - run: yarn install --frozen-lockfile",
    ],
  },
};

const BIOME_SUBCOMMANDS = {
  check: (paths) => ["check", ...paths],
  "check:fix": (paths) => ["check", "--write", ...paths],
  ci: (paths) => ["ci", "--reporter=github", ...paths],
};

const HELP = `Usage: bunx ${KIT_NAME} <command> [options]

Commands:
  init [options]   Set up Biome, scripts, hooks, and CI in the current project
  check [paths]     Run biome check (defaults to .)
  check:fix [paths] Run biome check --write (defaults to .)
  ci [paths]        Run biome ci --reporter=github (defaults to .)

init options:
  --preset <base|strict|next>  Which preset to extend (default: base)
  --no-hooks                   Skip husky + pre-commit hook setup
  --no-ci                      Skip the GitHub Actions workflow
  --skip-install                Print install commands instead of running them
  -h, --help                   Show this help

check / check:fix / ci run the Biome binary already installed in this
project's node_modules — you never need to call biome yourself. The
package manager (bun, npm, pnpm, or yarn) used by \`init\` is detected
from the "packageManager" field in package.json or from whichever
lockfile is present. Bun is used as the fallback when neither is found.

Once installed (after \`init\`), use the shorter alias for every command
except the first install: \`bunx biome-kit check\`, \`bunx biome-kit
check:fix\`, \`bunx biome-kit ci\`.
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

function detectPackageManager(cwd, pkg) {
  const declared = pkg.packageManager?.split("@")[0];
  if (declared && declared in PACKAGE_MANAGERS) return declared;
  for (const [name, pm] of Object.entries(PACKAGE_MANAGERS)) {
    if (existsSync(join(cwd, pm.lockfile))) return name;
  }
  return "bun";
}

function binPath(cwd, name) {
  return join(cwd, "node_modules", ".bin", name);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    preset: { type: "string", default: "base" },
    "no-hooks": { type: "boolean", default: false },
    "no-ci": { type: "boolean", default: false },
    "skip-install": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const command = positionals[0] ?? "init";
const cwd = process.cwd();

if (command in BIOME_SUBCOMMANDS) {
  const biome = binPath(cwd, "biome");
  if (!existsSync(biome)) {
    fail(`Biome isn't installed in this project. Run: bunx ${KIT_NAME} init`);
  }
  const extraPaths = positionals.slice(1);
  const biomeArgs = BIOME_SUBCOMMANDS[command](extraPaths.length ? extraPaths : ["."]);
  try {
    await $`${biome} ${biomeArgs}`.cwd(cwd);
  } catch (error) {
    process.exit(error.exitCode ?? 1);
  }
  process.exit(0);
}

if (command !== "init") {
  fail(`Unknown command "${command}". Usage: bunx ${KIT_NAME} <init|check|check:fix|ci> [options]`);
}

if (!(values.preset in PRESET_PATHS)) {
  fail(
    `Invalid preset "${values.preset}". Valid presets: ${Object.keys(PRESET_PATHS).join(", ")}.`,
  );
}

const pkgPath = join(cwd, "package.json");
if (!existsSync(pkgPath)) {
  fail("No package.json found in the current directory.");
}

const pkg = await Bun.file(pkgPath).json();
const pmName = detectPackageManager(cwd, pkg);
const pm = PACKAGE_MANAGERS[pmName];
ok(`Detected package manager: ${pmName}`);

const devPackages = ["@biomejs/biome", `${KIT_NAME}@${KIT_VERSION}`];
if (!values["no-hooks"]) devPackages.push("husky");
const installArgv = pm.install(devPackages);
const installCmd = installArgv.join(" ");

if (values["skip-install"]) {
  warn(`Skipped install. Run: ${installCmd}`);
} else {
  try {
    await $`${installArgv}`.cwd(cwd).quiet();
    ok(`Installed ${devPackages.join(", ")}`);
  } catch (error) {
    fail(`Install failed: ${error.message}`);
  }
}

const biomeJsonPath = join(cwd, "biome.json");
const biomeJsoncPath = join(cwd, "biome.jsonc");
const extendsSpecifier = `${KIT_NAME}/${PRESET_PATHS[values.preset]}`;

if (existsSync(biomeJsonPath) || existsSync(biomeJsoncPath)) {
  warn(`biome.json already exists — add this to its "extends": "${extendsSpecifier}"`);
} else {
  const config = {
    $schema: "./node_modules/@biomejs/biome/configuration_schema.json",
    extends: [extendsSpecifier],
  };
  if (values.preset === "next") {
    config.files = { includes: ["**", "!**/.next", "!**/out", "!**/next-env.d.ts"] };
  }
  await Bun.write(biomeJsonPath, `${JSON.stringify(config, null, 2)}\n`);
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
  await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

if (!values["no-hooks"]) {
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) {
    warn("No .git directory found — skipping husky hook setup");
  } else {
    const huskyDir = join(cwd, ".husky");
    const hookPath = join(huskyDir, "pre-commit");
    if (existsSync(hookPath)) {
      warn(".husky/pre-commit already exists — left untouched");
    } else {
      await $`mkdir -p ${huskyDir}`.quiet();
      await Bun.write(hookPath, await Bun.file(join(KIT_DIR, "templates", "pre-commit")).text());
      await $`chmod 755 ${hookPath}`.quiet();
      ok("Wrote .husky/pre-commit");
      if (values["skip-install"]) {
        warn("Skipped: run `node_modules/.bin/husky` to finish git hooks setup");
      } else {
        const husky = binPath(cwd, "husky");
        if (existsSync(husky)) {
          try {
            await $`${husky}`.cwd(cwd).quiet();
            ok("Ran husky");
          } catch (error) {
            warn(`husky failed: ${error.message}`);
          }
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
    const workflow = `name: Biome

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  biome:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${pm.setupSteps.join("\n")}
      - run: ${pm.runCheckCi}
`;
    await $`mkdir -p ${workflowsDir}`.quiet();
    await Bun.write(ciPath, workflow);
    ok("Wrote .github/workflows/biome.yml");
  }
}

console.log(`\nRun: ${pmName} run check:fix`);
