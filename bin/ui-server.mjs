import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { $ } from "bun";
import { ciStream, detectCiSteps } from "./ci.mjs";

const MAX_FILES = 200;

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safePath(cwd, file) {
  if (typeof file !== "string" || file.includes("\0")) return null;
  const abs = resolve(cwd, file);
  return isInside(cwd, abs) && abs !== cwd ? abs : null;
}

async function runCheck(cwd, biome) {
  const t0 = performance.now();
  console.log("… running biome check");
  const result = await $`${biome} check --reporter=json .`.cwd(cwd).quiet().nothrow();
  const out = result.stdout.toString().trim();
  console.log(
    `… biome finished in ${((performance.now() - t0) / 1000).toFixed(1)}s (${(out.length / 1024).toFixed(0)} KB of output)`,
  );
  const start = out.indexOf("{");
  if (start === -1) {
    throw new Error(result.stderr.toString().trim() || "Biome produced no JSON output");
  }
  const report = JSON.parse(out.slice(start));

  const byFile = new Map();
  for (const d of report.diagnostics ?? []) {
    const path = d.location?.path;
    if (!path) continue;
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push({
      severity: d.severity,
      message: d.message,
      category: d.category,
      start: d.location.start,
      end: d.location.end,
    });
  }

  const files = [...byFile].slice(0, MAX_FILES).map(([path, diagnostics]) => ({
    path,
    diagnostics,
  }));

  const s = report.summary ?? {};
  return {
    summary: { errors: s.errors ?? 0, warnings: s.warnings ?? 0, infos: s.infos ?? 0 },
    files,
    totalFiles: byFile.size,
    truncated: byFile.size > MAX_FILES,
  };
}

// Computed on demand (when the user opens a file) so a check on a big project
// doesn't have to spawn Biome once per file up front.
async function getDiff(cwd, biome, file) {
  const abs = safePath(cwd, file);
  if (!abs || !existsSync(abs)) throw new Error(`Invalid file: ${file}`);
  const original = await Bun.file(abs).text();
  const res = await $`${biome} check --write --stdin-file-path=${file} < ${new Response(original)}`
    .cwd(cwd)
    .quiet()
    .nothrow();
  const text = res.stdout.toString();
  const fixed = text.length > 0 ? text : null;
  return { original, fixed, fixable: fixed !== null && fixed !== original };
}

async function applyFixes(cwd, biome, files) {
  const paths = files.map((file) => {
    const abs = safePath(cwd, file);
    if (!abs || !existsSync(abs)) throw new Error(`Invalid file: ${file}`);
    return file;
  });
  const CHUNK = 100;
  for (let i = 0; i < paths.length; i += CHUNK) {
    await $`${biome} check --write ${paths.slice(i, i + CHUNK)}`.cwd(cwd).quiet().nothrow();
  }
}

export async function startUi({ cwd, biome, kitDir, port, open, pmName, pkg }) {
  let ciBusy = false;
  const token = crypto.randomUUID();
  const html = await Bun.file(join(kitDir, "ui", "index.html")).text();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/") {
        if (url.searchParams.get("t") !== token) {
          return new Response("Forbidden: open the URL printed by `lintlane ui`.", {
            status: 403,
          });
        }
        return new Response(html.replace("__TOKEN__", token), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (url.pathname.startsWith("/api/")) {
        if (req.headers.get("x-lintlane-token") !== token) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        try {
          if (req.method === "POST" && url.pathname === "/api/check") {
            return Response.json(await runCheck(cwd, biome));
          }
          if (req.method === "POST" && url.pathname === "/api/fix") {
            const { files } = await req.json();
            if (!Array.isArray(files) || files.length === 0) {
              return Response.json({ error: "No files given" }, { status: 400 });
            }
            await applyFixes(cwd, biome, files);
            return Response.json({ fixed: files.length });
          }
          if (req.method === "POST" && url.pathname === "/api/ci/steps") {
            const steps = detectCiSteps({ cwd, biome, pmName, pkg });
            return Response.json({
              pmName,
              steps: steps.map(({ id, label, display, defaultOn, note }) => ({
                id,
                label,
                display,
                defaultOn,
                note,
              })),
            });
          }
          if (req.method === "POST" && url.pathname === "/api/ci/run") {
            if (ciBusy)
              return Response.json({ error: "A CI run is already in progress" }, { status: 409 });
            const { steps: ids, stopOnFail } = await req.json();
            const known = detectCiSteps({ cwd, biome, pmName, pkg });
            const steps = Array.isArray(ids) ? known.filter((step) => ids.includes(step.id)) : [];
            if (steps.length === 0)
              return Response.json({ error: "No steps selected" }, { status: 400 });
            ciBusy = true;
            const stream = ciStream({
              cwd,
              steps,
              stopOnFail: stopOnFail !== false,
              release: () => {
                ciBusy = false;
              },
            });
            return new Response(stream, {
              headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
            });
          }
          if (req.method === "POST" && url.pathname === "/api/diff") {
            const { file } = await req.json();
            return Response.json(await getDiff(cwd, biome, file));
          }
        } catch (error) {
          return Response.json({ error: error.message }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const address = `http://127.0.0.1:${server.port}/?t=${token}`;
  console.log(`✔ Lintlane dashboard running at ${address}`);
  console.log("  Press Ctrl+C to stop.");

  if (open) {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    await $`${opener} ${address}`.quiet().nothrow();
  }
  return server;
}
