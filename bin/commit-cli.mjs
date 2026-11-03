// `lintlane commit` — guided Conventional Commit (Commitizen's `cz commit`).
//
//   lintlane commit [options] [-- <git commit args>]
//
//   --dry-run                      show the message, don't commit
//   --write-message-to-file <file> write the message to a file
//   --retry / --no-retry           reuse the last message after a failed commit / force a new prompt
//   -l, --message-length-limit <n> max header length (0 = no limit)
//   -- <args>                      everything after -- goes to `git commit`
//                                  (e.g. `-- -a -S` to stage all and sign, `-- -n` to skip hooks)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCommitConfig } from "./commit-config.mjs";
import { promptCommit } from "./commit-prompt.mjs";

export const COMMIT_HELP = `Usage: lintlane commit [options] [-- <git commit args>]

Asks a few questions and creates a Conventional Commit. Alias: lintlane c

Options:
  --dry-run                       Show the message without committing
  --write-message-to-file <file>  Write the message to a file (combine with --dry-run)
  --retry                         Reuse the last message after a failed commit
  --no-retry                      Always ask, even if retryAfterFailure is set
  -l, --message-length-limit <n>  Maximum header length (0 = no limit)

Anything after -- is passed to git commit:
  lintlane commit -- -a -S       stage all tracked changes and sign the commit
  lintlane commit -- -n          skip git hooks
  lintlane commit -- -s          add a Signed-off-by line
`;

const err = (text) => process.stderr.write(`${text}\n`);

function git(args, cwd, extra = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", ...extra });
}

export async function runCommit({ argv, gitArgs = [], cwd = process.cwd() }) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean" },
        "write-message-to-file": { type: "string" },
        retry: { type: "boolean" },
        "no-retry": { type: "boolean" },
        "message-length-limit": { type: "string", short: "l" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err(`✘ ${error.message}\n\n${COMMIT_HELP}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(COMMIT_HELP);
    return 0;
  }
  if (values.retry && values["no-retry"]) {
    err("✘ Use either --retry or --no-retry, not both.");
    return 2;
  }

  const inRepo = git(["rev-parse", "--git-dir"], cwd);
  if (inRepo.status !== 0) {
    err("✘ Not inside a git repository.");
    return 1;
  }

  const config = loadCommitConfig(cwd);
  const options = {
    ...config,
    messageLengthLimit: values["message-length-limit"] ?? config.messageLengthLimit,
  };
  const dryRun = Boolean(values["dry-run"]);

  // `-- -a` makes git stage tracked changes itself, so "nothing staged" is fine then.
  const stagesItself = gitArgs.some((a) => a === "-a" || a === "--all");
  if (!dryRun && !stagesItself && git(["diff", "--cached", "--quiet"], cwd).status === 0) {
    err(
      "✘ Nothing is staged. Stage your changes first (git add <files>), or use: lintlane commit -- -a",
    );
    return 1;
  }

  const savedPath = resolve(
    cwd,
    git(["rev-parse", "--git-path", "lintlane-commit-msg"], cwd).stdout.trim(),
  );
  const saved = existsSync(savedPath) ? readFileSync(savedPath, "utf8") : null;

  let message;
  const autoRetry = Boolean(config.retryAfterFailure) && !values["no-retry"] && saved !== null;
  if (values.retry || autoRetry) {
    if (saved === null) {
      err("✘ There's no previous commit message to retry.");
      return 1;
    }
    message = saved;
    err("↻ Reusing your last commit message:\n");
    err(message.replace(/^/gm, "  "));
    err("");
  } else {
    try {
      message = await promptCommit({ options });
    } catch {
      err("\n✘ Commit cancelled.");
      return 1;
    }
    if (message === null) {
      err("\n✘ Commit cancelled.");
      return 1;
    }
  }

  if (values["write-message-to-file"]) {
    const target = resolve(cwd, values["write-message-to-file"]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${message}\n`);
  }
  if (dryRun) {
    process.stdout.write(`${message}\n`);
    return 0;
  }

  // Keep the message until the commit actually succeeds, so a failing
  // pre-commit hook doesn't throw away your answers.
  mkdirSync(dirname(savedPath), { recursive: true });
  writeFileSync(savedPath, message);

  const result = spawnSync("git", ["commit", "-F", "-", ...gitArgs], {
    cwd,
    input: message,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status === 0) {
    rmSync(savedPath, { force: true });
    return 0;
  }
  err(
    "\n✘ git commit failed. Your message was saved — fix the problem, then run:  lintlane commit --retry",
  );
  return result.status ?? 1;
}
