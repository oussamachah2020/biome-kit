// git `pre-push` hook entry: checks every commit that's about to be pushed.
// This is the safety net for commits that skipped the commit-msg hook
// (`git commit --no-verify`, a GUI client, a clone where hooks weren't installed).
// Plain Node on purpose — see commit-lint.mjs.
import { readFileSync } from "node:fs";
import { describeInvalid, findInvalidCommits, listCommits } from "./check-commit.mjs";
import { loadCommitConfig } from "./commit-config.mjs";

const [remote = "origin"] = process.argv.slice(2);
const ZERO = /^0+$/;

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {}

const options = loadCommitConfig();
const invalid = [];
const seen = new Set();

for (const line of input.split("\n")) {
  const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
  if (!localRef || !localSha || ZERO.test(localSha)) continue; // deleting a branch
  if (localRef.startsWith("refs/tags/")) continue;

  // New branch: everything not already on a remote. Existing: just the new commits.
  const logArgs = ZERO.test(remoteSha ?? "0")
    ? [localSha, "--not", `--remotes=${remote}`]
    : [`${remoteSha}..${localSha}`];
  try {
    for (const bad of findInvalidCommits(listCommits(logArgs), options)) {
      if (!seen.has(bad.hash)) {
        seen.add(bad.hash);
        invalid.push(bad);
      }
    }
  } catch {
    // Can't inspect the range (e.g. the remote's commit isn't local). Don't block the push.
  }
}

if (invalid.length > 0) {
  process.stderr.write(
    `\n✘ Push blocked: ${invalid.length} commit message(s) don't follow Conventional Commits:\n\n${describeInvalid(invalid)}\n\n` +
      "  Reword them with `git rebase -i` (or `git commit --amend` for the latest), then push again.\n\n",
  );
  process.exit(1);
}
