// Shared helpers for the integration tests. Everything runs against real
// temporary git repositories; nothing is mocked unless a test says so.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(KIT_DIR, "bin", "cli.mjs");
export const PRE_COMMIT = join(KIT_DIR, "bin", "pre-commit.mjs");
export const KIT_BIOME = join(KIT_DIR, "node_modules", ".bin", "biome");

const created = [];

/** Make a temp directory that is removed when the test process exits. */
export function tempDir(prefix = "lintlane-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// Keep the developer's own git configuration, and any outer git hook's
// GIT_INDEX_FILE and friends, out of the temporary repositories.
const emptyGitConfig = join(tempDir("lintlane-gitconfig-"), "config");
writeFileSync(emptyGitConfig, "");

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // npm_config_user_agent says which tool launched the tests (npm, pnpm...); it must
    // not leak into the CLI under test, where it influences package-manager detection.
    if (!key.startsWith("GIT_") && key !== "npm_config_user_agent") env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    ...extra,
  };
}

/** Run git; returns { status, stdout, stderr } with strings. */
export function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: cleanEnv(), encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run git and return stdout, throwing if it fails. */
export function gitOut(cwd, ...args) {
  const result = git(cwd, ...args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

export const BIOME_CONFIG = {
  formatter: { indentStyle: "space", indentWidth: 2 },
  javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
  linter: { enabled: true },
};

export function write(dir, path, content) {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export function read(dir, path) {
  return readFileSync(join(dir, path), "utf8");
}

/**
 * A temp repository with a Biome config, an initial commit, and the lintlane
 * pre-commit hook installed.
 *   hook: "direct"   .git/hooks/pre-commit runs bin/pre-commit.mjs
 *         "template" .husky/pre-commit is the shipped template, using node_modules/lintlane
 *         "none"     no hook
 */
export function createRepo({ files = {}, config = BIOME_CONFIG, hook = "direct" } = {}) {
  const dir = tempDir();
  gitOut(dir, "init", "-q", "-b", "main");
  gitOut(dir, "config", "commit.gpgsign", "false");
  gitOut(dir, "config", "core.autocrlf", "false");
  write(dir, "biome.json", `${JSON.stringify(config, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  gitOut(dir, "add", "-A");
  gitOut(dir, "commit", "-q", "-m", "chore: initial commit");

  if (hook === "direct") {
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, `#!/bin/sh\nexec node "${PRE_COMMIT}"\n`);
    chmodSync(hookPath, 0o755);
  } else if (hook === "template") {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(KIT_DIR, join(dir, "node_modules", "lintlane"), "dir");
    mkdirSync(join(dir, ".husky"), { recursive: true });
    const hookPath = join(dir, ".husky", "pre-commit");
    writeFileSync(hookPath, readFileSync(join(KIT_DIR, "templates", "pre-commit")));
    chmodSync(hookPath, 0o755);
    gitOut(dir, "config", "core.hooksPath", ".husky");
  }
  return dir;
}

/** `git commit`, returning { status, stdout, stderr }. */
export function commit(dir, message = "test: change", ...extra) {
  return git(dir, "commit", "-m", message, ...extra);
}

/** Run the hook directly (what git does), without committing. */
export function runHook(dir) {
  const result = spawnSync("node", [PRE_COMMIT], { cwd: dir, env: cleanEnv(), encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function walk(root, dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const abs = join(dir, name);
    const rel = abs.slice(root.length + 1);
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) walk(root, abs, out);
    else out[rel] = { content: readFileSync(abs, "utf8"), exec: (stat.mode & 0o111) !== 0 };
  }
}

/**
 * Everything that matters about the repository's state: HEAD, the exact index
 * entries (mode, blob, stage, path), the porcelain status, and every file in
 * the working tree (including untracked ones) with its exact contents.
 */
export function snapshot(dir) {
  const files = {};
  walk(dir, dir, files);
  const head = git(dir, "rev-parse", "--verify", "-q", "HEAD");
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    index: gitOut(dir, "ls-files", "-s", "-z"),
    status: gitOut(dir, "status", "--porcelain=v1", "-z"),
    files,
  };
}

/** The staged (index) content of a path. */
export const staged = (dir, path) => gitOut(dir, "show", `:${path}`);
/** The committed content of a path at HEAD. */
export const committed = (dir, path) => gitOut(dir, "show", `HEAD:${path}`);
/** Paths changed in the last commit. */
export const lastCommitFiles = (dir) =>
  gitOut(dir, "show", "--name-only", "--format=", "-z", "HEAD").split("\0").filter(Boolean);

// ---------------------------------------------------------------- processes

/** Run the CLI as a child process. */
export function runCli(args, { cwd, env = {}, input } = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    cwd,
    env: cleanEnv(env),
    encoding: "utf8",
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function findExecutable(name) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * An environment where Bun can't be found: PATH holds only `node`, `git` and
 * the system directories. Returns null if Bun is still reachable that way.
 */
export function noBunEnv(extra = {}) {
  const bin = tempDir("lintlane-nobun-");
  symlinkSync(process.execPath, join(bin, "node"));
  const gitPath = findExecutable("git");
  if (gitPath) symlinkSync(gitPath, join(bin, "git"));
  const env = cleanEnv({ PATH: `${bin}:/usr/bin:/bin`, ...extra });
  const probe = spawnSync("bun", ["--version"], { env, encoding: "utf8" });
  return probe.error ? { env, bin } : null;
}

/**
 * Fake package manager executables in a temp bin directory. Each one records
 * its arguments and imitates the part of a real install that matters here:
 * adding the requested packages to package.json's devDependencies and creating
 * a husky binary. These are MOCKS: they test which command lintlane builds and
 * how it handles the result, not a real package manager.
 */
export function fakePackageManagers(names = ["npm", "pnpm", "yarn", "bun"]) {
  const bin = tempDir("lintlane-fakepm-");
  const log = join(bin, "calls.jsonl");
  writeFileSync(log, "");
  symlinkSync(process.execPath, join(bin, "node"));
  const gitPath = findExecutable("git");
  if (gitPath) symlinkSync(gitPath, join(bin, "git"));
  for (const name of names) {
    const script = join(bin, name);
    writeFileSync(
      script,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pm: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
const specs = process.argv.slice(2).filter((a) => !a.startsWith("-") && !["add", "install"].includes(a));
const pkgPath = path.join(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.devDependencies ??= {};
for (const spec of specs) {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  pkg.devDependencies[name] = at > 0 ? spec.slice(at + 1) : "1.0.0";
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\\n");
const binDir = path.join(process.cwd(), "node_modules", ".bin");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, "husky"), "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
`,
    );
    chmodSync(script, 0o755);
  }
  const env = cleanEnv({ PATH: `${bin}:/usr/bin:/bin` });
  return {
    env,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

/** Start a long-running child and resolve once its stdout matches `pattern`. */
export function startAndWait(command, args, { cwd, env, pattern, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for ${pattern}. Output so far:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve({ child, match, output: () => output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!pattern.test(output))
        reject(new Error(`Exited with ${code} before ${pattern}:\n${output}`));
    });
  });
}
