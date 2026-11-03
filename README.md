# lintlane

Pre-push checks for React apps. One command sets up a shared
[Biome](https://biomejs.dev) lint/format preset, git hooks, a Conventional
Commits workflow and a CI workflow; a local dashboard lets you run the same
checks your CI will run — and see exactly what would fail — before you push.

**What you get**

- A shared Biome preset (`base`, `strict`, `next`) with auto-detection.
- A pre-commit hook that formats and lints staged files.
- Conventional Commits, enforced and guided: a step-by-step prompt, a
  commit-message check, a pre-push check and a CI check.
- A GitHub Actions workflow running `biome ci`.
- `lintlane ui`: a local dashboard with a Lint tab (errors and fixes as a
  diff) and a CI tab (lint, typecheck, build and tests run locally).

## Contents

- [Quick start](#quick-start)
- [Commands at a glance](#commands-at-a-glance)
- [Requirements](#requirements)
- [`init`](#init--one-time-project-setup)
- [`check`, `check:fix`, `ci`](#check-checkfix-ci--run-biome)
- [Commit workflow](#commit-workflow)
  - [`commit`](#commit--guided-conventional-commit)
  - [`check-commit`](#check-commit--validate-commit-messages)
  - [Hooks: how a bad commit gets caught](#hooks-how-a-bad-commit-gets-caught)
  - [Settings](#settings)
  - [Skipping a check](#skipping-a-check)
- [Dashboard (`ui`)](#dashboard-ui)
- [Presets](#presets)
- [Manual setup (without the CLI)](#manual-setup-without-the-cli)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)
- [Developing lintlane](#developing-lintlane)

## Quick start

```sh
# 1. In your React project (a git repository with a package.json):
bunx lintlane init

# 2. Fix what Biome can fix, see what's left:
bunx lintlane check:fix
bunx lintlane check

# 3. Open the dashboard to review issues and run your CI checks locally:
bunx lintlane ui
```

From then on, `git commit` is guided and checked, and every push is checked
before it leaves your machine.

> The first `bunx lintlane init` downloads the package. After that it's
> installed in your project, so `bunx lintlane …` (or `npx lintlane …`,
> `bun run lintlane …`) runs your local copy without touching the network.

## Commands at a glance

| Command                                         | What it does                                                    |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `lintlane init [flags]`                         | One-time setup: installs, writes config, scripts, hooks and CI. |
| `lintlane check [paths]`                        | Run `biome check` (lint + format), no changes.                  |
| `lintlane check:fix [paths]`                    | Run `biome check --write`: apply safe fixes.                    |
| `lintlane ci [paths]`                           | Run `biome ci --reporter=github` (what CI runs).                |
| `lintlane commit [flags] [-- <git args>]`       | Guided Conventional Commit (alias `c`).                         |
| `lintlane check-commit [flags]`                 | Validate commit messages (a message, a file or a git range).    |
| `lintlane ui [flags]`                           | Open the local dashboard (Lint + CI tabs).                      |
| `lintlane -h` / `commit -h` / `check-commit -h` | Show help.                                                      |

Every command except `init` runs from the project root. Examples below use
`bunx lintlane …`; if you've installed it, `bun run lintlane …`,
`npx lintlane …` or `node_modules/.bin/lintlane …` work too.

## Requirements

- **Bun 1.2 or newer** to run the CLI (`init`, `check`, `check:fix`, `ci`,
  `commit`, `check-commit`, `ui`). The CLI is a Bun script.
- **Your project does not need to use Bun.** `init` detects npm, pnpm, Yarn or
  Bun and uses that package manager.
- **Git hooks only need Node** (18 or newer): they're plain Node scripts with no
  extra dependencies, so teammates don't need Bun to commit or push.
- **Biome 2.2 up to (not including) 3.** It's a peer dependency; `init` installs it.
- **Git**, for the commit workflow.
- **macOS or Linux** for the guided prompt on a plain `git commit` (it reads the
  terminal through `/dev/tty`). Elsewhere that prompt is skipped; messages are
  still validated, and `lintlane commit` still works. Not tested on Windows.

## `init` — one-time project setup

```sh
bunx lintlane init
```

`init` installs `@biomejs/biome`, `lintlane` and (unless `--no-hooks`)
`husky`, then writes:

| File / change                 | Purpose                                                           |
| ----------------------------- | ----------------------------------------------------------------- |
| `biome.json`                  | Extends the preset. If one exists, it only tells you what to add. |
| `package.json` scripts        | `check`, `check:fix`, and `prepare` (runs husky).                 |
| `.husky/pre-commit`           | Biome on staged files, auto-fixing what it can.                   |
| `.husky/commit-msg`           | Rejects messages that aren't Conventional Commits.                |
| `.husky/prepare-commit-msg`   | Guided prompt when you run a plain `git commit`.                  |
| `.husky/pre-push`             | Checks every commit about to be pushed.                           |
| `.github/workflows/biome.yml` | `biome ci`, plus a commit-message check on pull requests.         |

### Flags

| Flag               | Effect                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| `--preset <name>`  | `base`, `strict` or `next`; overrides auto-detection.                   |
| `--no-hooks`       | Skip husky and every git hook (also leaves the commit check out of CI). |
| `--no-commit-lint` | Keep the pre-commit hook; skip the commit-message hooks and CI check.   |
| `--no-ci`          | Skip the GitHub Actions workflow.                                       |
| `--skip-install`   | Print the install command instead of running it.                        |
| `-h`, `--help`     | Show usage.                                                             |

```sh
bunx lintlane init                                   # everything, preset auto-detected
bunx lintlane init --preset strict                   # force a preset
bunx lintlane init --no-commit-lint                  # lint hook only, no commit rules
bunx lintlane init --no-hooks --no-ci                # just biome.json and scripts
bunx lintlane init --skip-install                    # you install packages yourself
bunx lintlane init --preset next --no-ci
```

### Preset auto-detection

Without `--preset`, `init` reads your `package.json` dependencies:

| Found in dependencies                             | Preset used |
| ------------------------------------------------- | ----------- |
| `next`                                            | `next`      |
| `@tanstack/react-start`, `@tanstack/start`        | `base`      |
| `@react-router/dev` (React Router framework mode) | `base`      |
| `@remix-run/react`, `@remix-run/node`             | `base`      |
| `react` (no framework above)                      | `base`      |
| none of the above                                 | `base`      |

Only Next.js has its own Biome lint domain, so it's the only framework that
changes which preset is used. `init` says what it detected either way.
`strict` is never auto-selected; pass `--preset strict` when you want it.

### Package manager detection

`init` reads the `packageManager` field in `package.json`, otherwise whichever
lockfile is present (`bun.lock`, `package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`), and falls back to Bun. It uses that package manager's install
command and writes matching CI setup steps.

### Safe to re-run

`init` never overwrites an existing `biome.json`/`biome.jsonc`, script, hook or
workflow file; it prints a `!` warning for whatever already exists and writes
only what's missing. That makes it the way to **upgrade**: update the package,
then run `init` again to pick up hooks added in newer versions.

## `check`, `check:fix`, `ci` — run Biome

These wrap the Biome binary installed in your project, so you never need
Biome's own flags:

```sh
bunx lintlane check            # biome check .                      (read-only)
bunx lintlane check:fix        # biome check --write .              (applies safe fixes)
bunx lintlane ci               # biome ci --reporter=github .       (CI-formatted output)

bunx lintlane check src/                       # limit to paths
bunx lintlane check:fix src/components/Button.tsx
bunx lintlane ci src/ tests/
```

The exit code is Biome's, so they work in scripts and CI. If Biome isn't
installed yet they say so and point you to `init`.

`init` also adds plain `check` and `check:fix` scripts to `package.json` that
call `biome` directly, so `npm run check` (or `pnpm`/`yarn`/`bun run check`)
works without Bun:

```sh
npm run check
npm run check:fix
```

## Commit workflow

`init` sets up [Conventional Commits](https://www.conventionalcommits.org)
(`type(scope): subject`), which keeps history readable and works with changelog
and release tooling. The `commit` and `check-commit` commands and flags follow
[Commitizen](https://commitizen-tools.github.io/commitizen/) where they overlap
(`check-commit` is Commitizen's `cz check`; it isn't called `check` because
`lintlane check` runs Biome).

**The format**

```text
type(scope): subject

optional body

optional footer, e.g. Closes #123
BREAKING CHANGE: what breaks and how to migrate
```

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
  `build`, `ci`, `chore`, `revert`.
- The scope is optional. The subject is required, shouldn't end in a period,
  and the header must stay under 100 characters.
- A breaking change is marked with `!` (`feat(api)!: …`) plus a
  `BREAKING CHANGE:` footer.
- Messages starting with `Merge`, `Revert`, `Pull request`, `fixup!`,
  `squash!` or `amend!` are left alone.

### `commit` — guided Conventional Commit

```sh
git add <files>
bunx lintlane commit        # alias: bunx lintlane c
```

Asks seven questions — **type, scope, subject, body, breaking change, footer,
confirm** — then runs `git commit` with the result, so your pre-commit and
commit-msg hooks still run. It refuses if nothing is staged. Ctrl+C at any
step cancels with no commit made. Invalid answers (an empty subject, a trailing
period, an over-long header) are explained and asked again.

| Flag                             | Effect                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| `--dry-run`                      | Show the message without committing.                                 |
| `--write-message-to-file <file>` | Write the message to a file (combine with `--dry-run`).              |
| `--retry`                        | Reuse your last message after a failed commit, without asking again. |
| `--no-retry`                     | Always ask, even if `retryAfterFailure` is set.                      |
| `-l`, `--message-length-limit`   | Maximum header length (`0` = no limit).                              |
| `-h`, `--help`                   | Show help for this command.                                          |
| `-- <git args>`                  | Everything after `--` is passed to `git commit`.                     |

```sh
bunx lintlane commit                    # ask, then commit the staged changes
bunx lintlane commit -- -a              # stage all tracked changes, then commit
bunx lintlane commit -- -a -S           # …and sign the commit
bunx lintlane commit -- -s              # add a Signed-off-by line
bunx lintlane commit -- -n              # skip git hooks
bunx lintlane commit --dry-run          # just print the message
bunx lintlane commit --dry-run --write-message-to-file msg.txt
bunx lintlane commit -l 72              # stricter header limit for this commit
```

**Retrying after a failed commit.** If a hook (for example Biome in pre-commit)
rejects the commit after you've answered the questions, the message is kept.
Fix the problem, stage the fix, then run `bunx lintlane commit --retry` — no
re-typing. The saved message is cleared once a commit succeeds. Set
`retryAfterFailure` (see [Settings](#settings)) to reuse it automatically.

### `check-commit` — validate commit messages

Give it exactly one thing to check:

```sh
bunx lintlane check-commit --message "feat: add login"          # a message
echo "feat: add login" | bunx lintlane check-commit             # …or from stdin
bunx lintlane check-commit --commit-msg-file .git/COMMIT_EDITMSG
bunx lintlane check-commit --rev-range origin/main..HEAD        # every commit in a range
bunx lintlane check-commit -d                                   # shorthand for <default branch>..HEAD
```

| Flag                           | Effect                                                |
| ------------------------------ | ----------------------------------------------------- |
| `--message <msg>`              | Check this message (or pipe one in on stdin).         |
| `--commit-msg-file <path>`     | Check the message in a file.                          |
| `--rev-range <range>`          | Check every commit in a git range, e.g. `main..HEAD`. |
| `-d`, `--use-default-range`    | Same as `--rev-range <default branch>..HEAD`.         |
| `--allow-abort`                | Accept an empty message.                              |
| `--allowed-prefixes <prefix>`  | Skip messages starting with this (repeatable).        |
| `-l`, `--message-length-limit` | Maximum header length (`0` = no limit).               |

Exit codes: `0` everything passed, `1` a message was rejected, `2` a usage or
git error. For a range, the output lists each bad commit with its hash and why.

### Hooks: how a bad commit gets caught

Four layers, so a mistake is stopped somewhere:

| Layer                | Catches                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `prepare-commit-msg` | A plain `git commit` (no `-m`): walks you through the steps instead of opening an empty editor.                     |
| `commit-msg`         | `git commit -m "test"`: rejects a message in the wrong format, and says why.                                        |
| `pre-push`           | Commits that skipped the hooks (`--no-verify`, GUI clients, a fresh clone): checks every commit about to be pushed. |
| CI (pull requests)   | Anything that still got through: checks the commits in the PR.                                                      |

```text
$ git commit -m "test"

✘ Commit message rejected

  • The header must look like "type(scope): subject", e.g. "feat(auth): add login form".

  Format:   type(scope): subject
  Example:  feat(auth): add login form
  Types:    feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
```

Notes:

- On a plain `git commit` the prompt's answer pre-fills your editor, and the
  message is validated again afterwards. `git commit --amend`, `-m` and `-F`
  skip the prompt but not the validation.
- The prompt steps aside in CI, when `LINTLANE_NO_PROMPT` is set, and
  whenever there's no terminal (editors and GUI clients that commit for you).
- Hooks run only once git hooks are installed. `init` does this, and teammates
  get them from `install` through the `prepare` script (`husky`).
- The pre-push hook checks the commits being pushed (for a new branch: those
  not already on the remote). Tag pushes and branch deletions are ignored.

### Settings

Optional, in your `package.json`:

```json
{
  "lintlane": {
    "commit": {
      "types": ["feat", "fix", "chore"],
      "messageLengthLimit": 72,
      "allowedPrefixes": ["WIP"],
      "retryAfterFailure": true
    }
  }
}
```

| Key                  | Meaning                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `types`              | Allowed types. A list of names, or `{ "feat": "A new feature" }` to give each a description in the prompt. |
| `messageLengthLimit` | Maximum header length. `0` turns the check off. Default `100`.                                             |
| `allowedPrefixes`    | Extra message prefixes to skip (added to the built-in ones).                                               |
| `retryAfterFailure`  | Reuse your last message automatically after a failed commit. Default `false`.                              |

The settings apply to the hooks, `commit` and `check-commit`. Command-line flags
override them for that run.

### Skipping a check

| To skip…                  | Do this                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| The commit hooks, once    | `git commit --no-verify` (the pre-push hook and CI still check it).     |
| The pre-push check, once  | `git push --no-verify` (CI still checks pull requests).                 |
| Only the guided prompt    | Set `LINTLANE_NO_PROMPT=1`.                                             |
| Commit rules for everyone | Re-run `init --no-commit-lint` on a fresh project, or delete the hooks. |

### Adding the CI step to an existing workflow

`init` adds the commit-message check only to newly generated workflows. To add
it to one you already have:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
# …after your install step:
- name: Check commit messages
  if: github.event_name == 'pull_request'
  run: node node_modules/lintlane/bin/check-commit.mjs --rev-range origin/${{ github.base_ref }}..HEAD
```

## Dashboard (`ui`)

`lintlane ui` starts a local dashboard in your browser so you can see what
would fail before you push:

```sh
bunx lintlane ui              # opens http://127.0.0.1:4321
bunx lintlane ui --port 5000  # use another port
bunx lintlane ui --no-open    # print the URL without opening a browser
```

| Flag         | Effect                                |
| ------------ | ------------------------------------- |
| `--port <n>` | Port to listen on (default `4321`).   |
| `--no-open`  | Don't open the browser automatically. |

It needs Biome installed in the project (run `init` first). Press Ctrl+C in the
terminal to stop it. The ☀/☾ button in the header switches between light and
dark mode; it follows your system setting until you click it, then remembers
your choice.

### Lint tab

Runs `biome check` and shows the result:

- **Summary cards:** errors, warnings, files with issues, check time.
- **File table:** each file's worst level, issue count, and whether Biome can fix
  it. Rows with errors are tinted. Search by file name, message or rule, and
  filter by All / Errors / Warnings.
- **Detail panel:** click a file to see each issue (rule, line and column) and
  the proposed fix as a red/green diff, like `git diff`. Use ↑/↓ (or `j`/`k`) to
  move between files and `Esc` to close.
- **Apply fix** writes the fix for one file; **Apply all fixes** applies them to
  every listed file in one batch. Nothing is written until you click, and the
  page re-checks afterwards.

Only Biome's _safe_ fixes are applied (the same ones as `check:fix`). Issues
with no automatic fix are labelled "Manual". The page lists the first 200 files
with issues; if there are more, a notice says so and "Apply all fixes" only
touches the files shown — click it again after the re-check to continue.

### CI tab

Runs the checks your CI would run, locally. The steps are detected from your
project:

| Step                      | Runs                                                                                                              | On by default |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------- |
| Install (frozen lockfile) | `bun install --frozen-lockfile`, `npm ci`, or the `pnpm`/`yarn` equivalent                                        | No            |
| Biome CI (lint + format)  | `biome ci .` — the same check the generated GitHub workflow runs                                                  | Yes           |
| Typecheck                 | your `typecheck` script (or `type-check`, `check-types`, `tsc`), else `tsc --noEmit` if there's a `tsconfig.json` | Yes           |
| Build                     | your `build` script                                                                                               | Yes           |
| Tests                     | your `test` script (skipped if it's npm's "no test specified" placeholder)                                        | Yes           |

Tick the steps you want, then **Run CI**. Steps run in order with `CI=true`,
and their output streams into the panel as they run. **Stop on first failure**
(on by default, like real CI) skips the remaining steps after one fails. At the
end a banner says either "All N steps passed — safe to push" or "CI would
fail", naming the first failing step. **Stop** cancels the run and kills the
running process.

This is a script-based simulation, not a replica of your workflow: it runs the
commands above, not the steps in `.github/workflows/*.yml`, and it doesn't
reproduce CI's environment variables, secrets or Node version. A pass here is a
strong signal, not a guarantee.

### Safety

The server listens on `127.0.0.1` only. Every request needs a random token that
is part of the URL printed at startup — opening the dashboard without it gives a
403. The page only sends step ids and file paths; the server decides which
commands run and refuses paths outside the project.

## Presets

| Name                    | Extends path            | Use case                                                                                         |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `lintlane/biome`        | `./presets/base.json`   | Default: recommended rules + React domain, warns on unused code/console.                         |
| `lintlane/biome/strict` | `./presets/strict.json` | Base rules raised to errors (unused code, `any`, non-null assertions, console, exhaustive deps). |
| `lintlane/biome/next`   | `./presets/next.json`   | Base preset plus the Next.js lint domain.                                                        |

Presets intentionally don't set `files.includes` — setting it in your own
`biome.json` would _replace_ lintlane's, not merge with it. For Next.js apps,
add your own ignores:

```json
{
  "extends": ["lintlane/biome/next"],
  "files": { "includes": ["**", "!**/.next", "!**/out", "!**/next-env.d.ts"] }
}
```

To migrate an existing config into Biome first:

```sh
bunx biome migrate eslint --write
bunx biome migrate prettier --write
```

## Manual setup (without the CLI)

**Install and configure**

```sh
bun add -d -E @biomejs/biome lintlane
npm install --save-dev --save-exact @biomejs/biome lintlane
pnpm add --save-dev --save-exact @biomejs/biome lintlane
yarn add --dev --exact @biomejs/biome lintlane
```

Create `biome.json`, extending the preset you want:

```json
{ "extends": ["lintlane/biome"] }
```

(`lintlane/biome/strict` or `lintlane/biome/next` for the others.)
Add scripts:

```json
"check": "biome check .",
"check:fix": "biome check --write ."
```

**Git hooks**

```sh
bun add -d husky
bunx husky init
```

Put these in `.husky/`:

`.husky/pre-commit`

```sh
./node_modules/.bin/biome check --write --staged --no-errors-on-unmatched --files-ignore-unknown=true
git update-index --again
```

`.husky/commit-msg`

```sh
[ -f node_modules/lintlane/bin/commit-msg.mjs ] || exit 0
node node_modules/lintlane/bin/commit-msg.mjs "$1"
```

`.husky/prepare-commit-msg`

```sh
[ -f node_modules/lintlane/bin/prepare-commit-msg.mjs ] || exit 0
node node_modules/lintlane/bin/prepare-commit-msg.mjs "$1" "$2"
```

`.husky/pre-push`

```sh
[ -f node_modules/lintlane/bin/pre-push-check.mjs ] || exit 0
node node_modules/lintlane/bin/pre-push-check.mjs "$1" "$2"
```

Commits with errors Biome can't fix are blocked until you resolve them.

## Troubleshooting

**`bunx lintlane …` downloads the package each time, or says "command not found".**
Outside a project that has it installed, `bunx` fetches `lintlane` from npm.
Run `bunx lintlane init` in the project first (or install `lintlane` as a dev
dependency), after which `bunx lintlane …` uses the local copy.

**Hooks don't run.** Run your package manager's install (the `prepare` script
runs husky), or run `node_modules/.bin/husky` once. Check
`git config core.hooksPath` prints `.husky/_`.

**The guided prompt doesn't appear on `git commit`.** It's skipped when `CI` or
`LINTLANE_NO_PROMPT` is set, when you pass `-m`/`-F` or amend, when there's no
terminal (GUI clients, some editors) and on systems without `/dev/tty`. Run
`bunx lintlane commit` for the same steps. The message is validated regardless.

**A commit was rejected and I lost my message.** Use
`bunx lintlane commit --retry` if you committed through `lintlane commit`.

**The pre-commit hook blocks my commit.** Biome found an error it can't fix.
Run `bunx lintlane check` to see it, or open `bunx lintlane ui`. Fix it and
commit again.

**Push blocked: "commit message(s) don't follow Conventional Commits".** Reword
the listed commits with `git rebase -i` (or `git commit --amend` for the latest),
then push again.

**`init` says a file already exists.** That's expected; `init` never overwrites.
Delete the file and re-run `init` if you want lintlane's version.

**The dashboard shows "Unauthorized" / 403.** Open the exact URL printed when
`lintlane ui` started; it contains a one-time token.

**Biome seems slow on a big project.** Add ignores for build output in your
`biome.json` (for example `dist`, `.next`, `build`, `coverage`) so Biome doesn't
scan them.

## Reference

**Environment variables**

| Variable             | Effect                                                                            |
| -------------------- | --------------------------------------------------------------------------------- |
| `LINTLANE_NO_PROMPT` | Set to any value to skip the guided prompt on `git commit`.                       |
| `CI`                 | When set, the guided prompt is skipped. The CI tab sets it for the steps it runs. |
| `NO_COLOR`           | Turns off colors in the prompt.                                                   |

**Exit codes**

| Command                    | Codes                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `check`, `check:fix`, `ci` | Biome's exit code.                                                                                  |
| `commit`                   | `0` committed (or dry run), `1` cancelled, git's own exit code if the commit failed, `2` bad flags. |
| `check-commit`             | `0` valid, `1` rejected, `2` usage or git error.                                                    |
| `ui`                       | Runs until you stop it.                                                                             |

**Files lintlane may create or use**

| Path                                                                | What                                           |
| ------------------------------------------------------------------- | ---------------------------------------------- |
| `biome.json`                                                        | Biome config extending a preset.               |
| `.husky/pre-commit`, `commit-msg`, `prepare-commit-msg`, `pre-push` | Git hooks.                                     |
| `.github/workflows/biome.yml`                                       | CI workflow.                                   |
| `.git/lintlane-commit-msg`                                          | Your last message, kept after a failed commit. |

## Developing lintlane

To try a local build in a test app before publishing:

```sh
# In the lintlane repo:
npm pack --pack-destination /tmp/lintlane-pack     # builds lintlane-<version>.tgz

# In a throwaway app (a git repo with a package.json):
bun add --dev --exact @biomejs/biome husky /tmp/lintlane-pack/lintlane-<version>.tgz
node_modules/.bin/lintlane init --skip-install      # the package isn't on npm yet
node_modules/.bin/husky
```

If you rebuild without changing the version, Bun may reuse its cached tarball:
run `bun pm cache rm`, delete `node_modules/lintlane`, and reinstall (or
bump the version first). `npm pack --dry-run` lists what would be published.

## License

MIT
