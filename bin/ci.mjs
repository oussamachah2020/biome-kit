import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { binPath, spawnPrepared } from "./proc.mjs";

const MAX_LOG_CHARS = 2_000_000;

const RUN_SCRIPT = {
  bun: (name) => ["bun", "run", name],
  npm: (name) => ["npm", "run", name],
  pnpm: (name) => ["pnpm", "run", name],
  yarn: (name) => ["yarn", "run", name],
};

// Same commands the generated GitHub workflow uses for its install step.
const FROZEN_INSTALL = {
  bun: ["bun", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  yarn: ["yarn", "install", "--frozen-lockfile"],
};

const NPM_DEFAULT_TEST = /no test specified/i;

function firstScript(scripts, names) {
  return names.find((name) => typeof scripts[name] === "string");
}

/**
 * Work out which CI steps this project can run locally. Only commands the
 * project itself defines (package.json scripts, its own Biome) are offered,
 * and the browser only ever sends step ids back — never command lines.
 */
export function detectCiSteps({ cwd, biome, pmName, pkg }) {
  // `biome` is an argv prefix: [path] or [node, script] (see resolveBiome).
  const scripts = pkg?.scripts ?? {};
  const run = RUN_SCRIPT[pmName] ?? RUN_SCRIPT.npm;
  const steps = [];

  steps.push({
    id: "install",
    label: "Install (frozen lockfile)",
    cmd: FROZEN_INSTALL[pmName] ?? FROZEN_INSTALL.npm,
    defaultOn: false,
    note: "What CI does first. Reinstalls node_modules, so it's off by default.",
  });

  steps.push({
    id: "biome",
    label: "Biome CI (lint + format)",
    cmd: [...biome, "ci", "--colors=off", "."],
    display: "biome ci .",
    defaultOn: true,
    note: "The same check the GitHub workflow runs.",
  });

  const typecheck = firstScript(scripts, ["typecheck", "type-check", "check-types", "tsc"]);
  if (typecheck) {
    steps.push({
      id: "typecheck",
      label: "Typecheck",
      cmd: run(typecheck),
      defaultOn: true,
    });
  } else if (existsSync(`${cwd}/tsconfig.json`) && existsSync(binPath(cwd, "tsc"))) {
    steps.push({
      id: "typecheck",
      label: "Typecheck",
      cmd: [binPath(cwd, "tsc"), "--noEmit"],
      display: "tsc --noEmit",
      defaultOn: true,
    });
  }

  if (typeof scripts.build === "string") {
    steps.push({ id: "build", label: "Build", cmd: run("build"), defaultOn: true });
  }

  if (typeof scripts.test === "string" && !NPM_DEFAULT_TEST.test(scripts.test)) {
    steps.push({ id: "test", label: "Tests", cmd: run("test"), defaultOn: true });
  }

  return steps.map((step) => ({ ...step, display: step.display ?? step.cmd.join(" ") }));
}

// Kill the step and everything it started (a build tool's child processes too).
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

/**
 * Run steps one after another, reporting events through `send`:
 *   start / log / end / skip / done
 * Aborting `signal` (the browser's Stop button, or the page closing) kills the
 * running step. Resolves when the run is over; never rejects.
 */
export async function runCiSteps({ cwd, steps, stopOnFail, send, signal }) {
  let child = null;
  const onAbort = () => killTree(child);
  signal?.addEventListener("abort", onAbort);
  let failed = false;

  try {
    for (const step of steps) {
      if (signal?.aborted) return;
      if (failed && stopOnFail) {
        send({ type: "skip", id: step.id });
        continue;
      }

      send({ type: "start", id: step.id });
      const t0 = performance.now();
      let sent = 0;
      let truncated = false;

      const pump = (stream) => {
        const decoder = new StringDecoder("utf8");
        stream.on("data", (chunk) => {
          const text = decoder.write(chunk);
          if (sent < MAX_LOG_CHARS) {
            sent += text.length;
            send({ type: "log", id: step.id, text });
          } else if (!truncated) {
            truncated = true;
            send({ type: "log", id: step.id, text: "\n… output truncated …\n" });
          }
        });
      };

      const code = await new Promise((resolve) => {
        try {
          child = spawnPrepared(step.cmd[0], step.cmd.slice(1), {
            cwd,
            env: { ...process.env, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32", // own process group, so Stop can kill the tree
          });
        } catch (error) {
          send({ type: "log", id: step.id, text: `\n${error.message}\n` });
          resolve(127);
          return;
        }
        pump(child.stdout);
        pump(child.stderr);
        child.on("error", (error) => {
          send({ type: "log", id: step.id, text: `\n${error.message}\n` });
          resolve(127);
        });
        child.on("close", (exitCode, killedBy) => resolve(exitCode ?? (killedBy ? 143 : 1)));
      });
      child = null;

      if (signal?.aborted) return;
      if (code !== 0) failed = true;
      send({ type: "end", id: step.id, code, ms: Math.round(performance.now() - t0) });
    }
    send({ type: "done" });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
