// git `prepare-commit-msg` hook entry: when you run a plain `git commit` (no -m,
// no template, not a merge), walk through the guided prompt and pre-fill the
// message — the same flow as `lintlane commit`.
// Plain Node on purpose — see commit-lint.mjs.
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { ReadStream } from "node:tty";
import { loadCommitConfig } from "./commit-config.mjs";
import { promptCommit } from "./commit-prompt.mjs";

const [file, source] = process.argv.slice(2);

// source is set when the message came from -m/-F, a template, a merge, a
// squash, or an amend. Only a plain `git commit` leaves it empty.
if (!file || source || process.env.CI || process.env.LINTLANE_NO_PROMPT) process.exit(0);

// Git runs hooks with stdin detached; talk to the terminal directly. If there
// isn't one (a GUI client, CI, a script), stay out of the way.
let fd;
try {
  fd = openSync("/dev/tty", "r");
} catch {
  process.exit(0);
}

try {
  const message = await promptCommit({
    input: new ReadStream(fd),
    output: process.stderr,
    options: loadCommitConfig(),
  });
  if (message === null) {
    process.stderr.write("\nCommit cancelled.\n");
    process.exit(1);
  }
  const existing = readFileSync(file, "utf8");
  writeFileSync(file, `${message}\n${existing}`);
  // The open terminal handle would otherwise keep this process (and git) waiting.
  process.exit(0);
} catch {
  process.stderr.write("\nCommit cancelled.\n");
  process.exit(1);
} finally {
  try {
    closeSync(fd);
  } catch {}
}
