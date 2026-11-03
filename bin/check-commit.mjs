// `preflight check-commit` — validate commit messages (Commitizen's `cz check`).
// Plain Node on purpose: it also runs in CI and in the pre-push hook.
//
//   --message "<msg>"            check a string (or pipe it in on stdin)
//   --commit-msg-file <path>     check a message file (what the commit-msg hook does)
//   --rev-range <range>          check every commit in a git range, e.g. main..HEAD
//   -d, --use-default-range      same as --rev-range <default branch>..HEAD
//   --allow-abort                accept an empty message (git aborts those itself)
//   --allowed-prefixes <p>       extra message prefixes to skip (repeatable)
//   -l, --message-length-limit N max header length (0 = no limit)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadCommitConfig } from "./commit-config.mjs";
import { cleanMessage, explainFailure, validateMessage } from "./commit-lint.mjs";

const HELP = `Usage: preflight check-commit [options]

Checks that commit messages follow Conventional Commits. Give exactly one of:
  --message <msg>            a message (or pipe one in: echo "feat: x" | preflight check-commit)
  --commit-msg-file <path>   a file containing the message
  --rev-range <range>        every commit in a range, e.g. origin/main..HEAD
  -d, --use-default-range    shorthand for <default branch>..HEAD

Options:
  --allow-abort                  Accept an empty message
  --allowed-prefixes <prefix>    Skip messages starting with this (repeatable)
  -l, --message-length-limit <n> Maximum header length (0 = no limit)
`;

const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Commits reachable by the given `git log` arguments, oldest last. */
export function listCommits(logArgs, cwd = process.cwd()) {
  const out = git(["log", "--format=%H%x1f%B%x1e", ...logArgs], cwd);
  return out
    .split("\x1e")
    .map((entry) => entry.replace(/^\n/, ""))
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const [hash, ...message] = entry.split("\x1f");
      return { hash: hash.trim(), message: message.join("\x1f") };
    });
}

/** Validate commits; returns only the failing ones, with their errors. */
export function findInvalidCommits(commits, options) {
  const invalid = [];
  for (const commit of commits) {
    const result = validateMessage(commit.message, options);
    if (!result.valid) invalid.push({ ...commit, errors: result.errors });
  }
  return invalid;
}

export function describeInvalid(invalid) {
  return invalid
    .map((c) => {
      const subject = cleanMessage(c.message).split("\n")[0] || "(empty message)";
      return `  ${c.hash.slice(0, 8)}  ${subject}\n${c.errors.map((e) => `            • ${e}`).join("\n")}`;
    })
    .join("\n");
}

function defaultBranchRange(cwd) {
  const candidates = [];
  try {
    candidates.push(git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd).trim());
  } catch {}
  candidates.push("origin/main", "origin/master", "main", "master");
  for (const ref of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", ref], cwd);
      return `${ref}..HEAD`;
    } catch {}
  }
  throw new Error(
    "Couldn't find a default branch (tried origin/HEAD, main, master). Use --rev-range.",
  );
}

export async function main(argv, cwd = process.cwd()) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        message: { type: "string" },
        "commit-msg-file": { type: "string" },
        "rev-range": { type: "string" },
        "use-default-range": { type: "boolean", short: "d" },
        "allow-abort": { type: "boolean" },
        "allowed-prefixes": { type: "string", multiple: true },
        "message-length-limit": { type: "string", short: "l" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    process.stderr.write(`✘ ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const config = loadCommitConfig(cwd);
  const options = {
    ...config,
    allowAbort: values["allow-abort"] ?? config.allowAbort,
    allowedPrefixes: [...(config.allowedPrefixes ?? []), ...(values["allowed-prefixes"] ?? [])],
    messageLengthLimit: values["message-length-limit"] ?? config.messageLengthLimit,
  };

  const modes = [
    values.message,
    values["commit-msg-file"],
    values["rev-range"],
    values["use-default-range"],
  ].filter((v) => v !== undefined && v !== false).length;
  if (modes > 1) {
    process.stderr.write(
      `✘ Choose only one of --message, --commit-msg-file, --rev-range, --use-default-range.\n`,
    );
    return 2;
  }

  try {
    let invalid;
    let checked;
    if (values["rev-range"] || values["use-default-range"]) {
      const range = values["rev-range"] ?? defaultBranchRange(cwd);
      const commits = listCommits([range], cwd);
      checked = commits.length;
      invalid = findInvalidCommits(commits, options);
    } else {
      let raw;
      if (values.message !== undefined) raw = values.message;
      else if (values["commit-msg-file"]) raw = readFileSync(values["commit-msg-file"], "utf8");
      else if (!process.stdin.isTTY) raw = readFileSync(0, "utf8");
      else {
        process.stderr.write(`✘ Nothing to check.\n\n${HELP}`);
        return 2;
      }
      checked = 1;
      const result = validateMessage(raw, options);
      invalid = result.valid ? [] : [{ hash: "", message: raw, errors: result.errors }];
    }

    if (invalid.length === 0) {
      process.stdout.write(`✔ Commit validation successful (${checked} checked).\n`);
      return 0;
    }
    if (
      values.message !== undefined ||
      values["commit-msg-file"] ||
      (!values["rev-range"] && !values["use-default-range"])
    ) {
      process.stderr.write(`${explainFailure(invalid[0].errors, options)}\n`);
    } else {
      process.stderr.write(
        `\n✘ ${invalid.length} of ${checked} commit message(s) don't follow Conventional Commits:\n\n${describeInvalid(invalid)}\n\n` +
          "  Fix them with `git rebase -i` (reword) or `git commit --amend` for the latest one.\n\n",
      );
    }
    return 1;
  } catch (error) {
    const detail = error.stderr?.toString().trim().split("\n")[0] || error.message;
    process.stderr.write(`✘ ${detail}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
