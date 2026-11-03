// Runs the staged-files check with a fake Biome command (argv after the repo path).
//   node run-staged.mjs <repo> <biome command...>
import { runStagedChecks } from "../bin/staged.mjs";

const [cwd, ...biome] = process.argv.slice(2);
const result = await runStagedChecks({ cwd, biome });
process.exit(result.ok ? 0 : 1);
