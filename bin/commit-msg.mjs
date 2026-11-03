// git `commit-msg` hook entry: rejects messages that aren't Conventional Commits.
// Plain Node on purpose — see commit-lint.mjs.
import { readFileSync } from "node:fs";
import { loadCommitConfig } from "./commit-config.mjs";
import { explainFailure, validateMessage } from "./commit-lint.mjs";

const file = process.argv[2];
if (!file) {
  process.stderr.write("commit-msg: expected the path to the commit message file.\n");
  process.exit(2);
}

const options = loadCommitConfig();
const result = validateMessage(readFileSync(file, "utf8"), options);
if (!result.valid) {
  process.stderr.write(`${explainFailure(result.errors, options)}\n`);
  process.exit(1);
}
