import { existsSync } from "node:fs";
import { join } from "node:path";

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
    cmd: [biome, "ci", "--colors=off", "."],
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
  } else if (
    existsSync(join(cwd, "tsconfig.json")) &&
    existsSync(join(cwd, "node_modules", ".bin", "tsc"))
  ) {
    steps.push({
      id: "typecheck",
      label: "Typecheck",
      cmd: [join(cwd, "node_modules", ".bin", "tsc"), "--noEmit"],
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

/**
 * Run steps one after another and stream NDJSON events:
 *   start / log / end / skip / done
 * Closing the response (the browser's Stop button) kills the running process.
 */
export function ciStream({ cwd, steps, stopOnFail, release }) {
  const encoder = new TextEncoder();
  let proc = null;
  let cancelled = false;

  return new ReadableStream({
    async start(controller) {
      const send = (event) => {
        if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      let failed = false;

      try {
        for (const step of steps) {
          if (cancelled) break;
          if (failed && stopOnFail) {
            send({ type: "skip", id: step.id });
            continue;
          }

          send({ type: "start", id: step.id });
          const t0 = performance.now();
          let code = 1;
          let sent = 0;
          let truncated = false;

          const pump = async (readable) => {
            const decoder = new TextDecoder();
            for await (const chunk of readable) {
              const text = decoder.decode(chunk, { stream: true });
              if (sent < MAX_LOG_CHARS) {
                sent += text.length;
                send({ type: "log", id: step.id, text });
              } else if (!truncated) {
                truncated = true;
                send({ type: "log", id: step.id, text: "\n… output truncated …\n" });
              }
            }
          };

          try {
            proc = Bun.spawn(step.cmd, {
              cwd,
              env: { ...process.env, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            });
            await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
            code = await proc.exited;
          } catch (error) {
            send({ type: "log", id: step.id, text: `\n${error.message}\n` });
            code = 127;
          }
          proc = null;

          if (cancelled) break;
          if (code !== 0) failed = true;
          send({ type: "end", id: step.id, code, ms: Math.round(performance.now() - t0) });
        }
        send({ type: "done" });
      } finally {
        release();
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      proc?.kill();
    },
  });
}
