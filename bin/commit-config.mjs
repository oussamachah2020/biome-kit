// Reads the optional commit settings from the project's package.json:
//
//   "lintlane": {
//     "commit": {
//       "types": ["feat", "fix", "chore"],
//       "messageLengthLimit": 72,
//       "allowedPrefixes": ["WIP"],
//       "retryAfterFailure": true
//     }
//   }
//
// Plain Node, never throws: a missing or broken file just means defaults.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadCommitConfig(cwd = process.cwd()) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const commit = pkg?.lintlane?.commit;
    return commit && typeof commit === "object" ? commit : {};
  } catch {
    return {};
  }
}
