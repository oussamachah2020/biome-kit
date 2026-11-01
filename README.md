# @ovt2/biome-react-kit

Shared Biome lint/format/check preset for our React apps.

## Setup

One command installs Biome and the kit, writes `biome.json`, adds the
`check`/`check:fix` scripts, and wires up the pre-commit hook and CI workflow:

```sh
bunx @ovt2/biome-react-kit init
```

Options:

| Flag              | Effect                                             |
| ----------------- | -------------------------------------------------- |
| `--preset <name>` | `base` (default), `strict`, or `next`              |
| `--no-hooks`      | Skip husky + the pre-commit hook                   |
| `--no-ci`         | Skip the GitHub Actions workflow                   |
| `--skip-install`  | Print the install commands instead of running them |
| `-h, --help`      | Show usage                                         |

`init` never overwrites an existing `biome.json`/`biome.jsonc`, script, hook,
or workflow file — running it again is safe and only reports what's missing.

`init` itself always runs through `bunx` (the script is a Bun executable),
but it doesn't require your project to use Bun: it detects your package
manager from the `packageManager` field in `package.json`, or otherwise from
whichever lockfile is present (`bun.lock`, `package-lock.json`,
`pnpm-lock.yaml`, `yarn.lock`), and uses that package manager's install
command and CI setup. It falls back to Bun only when none of those is
found. The pre-commit hook always calls the locally installed
`node_modules/.bin/biome`, so it works the same regardless of which package
manager installed it.

## CLI commands

Beyond `init`, the kit's own CLI wraps the Biome binary it already installed
in your project, so you never have to know Biome's own flags. Once it's
installed, use the short `biome-kit` alias instead of the full package name
— `bunx` resolves it from `node_modules/.bin` without touching the network:

```sh
bunx biome-kit check            # biome check .
bunx biome-kit check:fix        # biome check --write .
bunx biome-kit ci               # biome ci --reporter=github .
bunx biome-kit check src/foo.ts # pass specific paths through
```

(The full name `@ovt2/biome-react-kit` still works everywhere `biome-kit`
does — it's the same binary under two names. You only _need_ the full name
once, for the very first `init`, since `bunx` has to resolve that from the
registry before anything is installed locally.)

These require Bun to invoke (same as `init`), since the CLI itself is a Bun
script. The `check`/`check:fix` scripts that `init` writes into your
`package.json` call `biome` directly instead, so `npm run check` (or
`pnpm`/`yarn run check`) stays Bun-free for everyday use — the CLI commands
above are a convenience for anyone who already has Bun and wants one
consistent command across projects.

See the [Command reference](#command-reference) below for every flag and
manual (non-CLI) setup path.

## Presets

| Name                                 | Extends path            | Use case                                                                                         |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `@ovt2/biome-react-kit/biome`        | `./presets/base.json`   | Default: recommended rules + React domain, warns on unused code/console.                         |
| `@ovt2/biome-react-kit/biome/strict` | `./presets/strict.json` | Base rules raised to errors (unused code, `any`, non-null assertions, console, exhaustive deps). |
| `@ovt2/biome-react-kit/biome/next`   | `./presets/next.json`   | Base preset plus the Next.js lint domain.                                                        |

Presets intentionally don't set `files.includes` — setting it in your own
`biome.json` would _replace_ the kit's, not merge with it. For Next.js apps,
add your own ignores:

```json
{
  "extends": ["@ovt2/biome-react-kit/biome/next"],
  "files": { "includes": ["**", "!**/.next", "!**/out", "!**/next-env.d.ts"] }
}
```

Add scripts:

```json
"check": "biome check .",
"check:fix": "biome check --write ."
```

## Command reference

Every command this kit provides, for every case.

### `init` — one-time project setup

```sh
# Default: base preset, installs husky + CI workflow
bunx @ovt2/biome-react-kit init

# Pick a different preset
bunx @ovt2/biome-react-kit init --preset strict
bunx @ovt2/biome-react-kit init --preset next

# Skip the pre-commit hook (no husky install, no .husky/pre-commit, no "prepare" script)
bunx @ovt2/biome-react-kit init --no-hooks

# Skip the GitHub Actions workflow (no .github/workflows/biome.yml)
bunx @ovt2/biome-react-kit init --no-ci

# Don't install anything — just print the install command and write the
# files that don't depend on packages being present yet
bunx @ovt2/biome-react-kit init --skip-install

# Combine flags freely
bunx @ovt2/biome-react-kit init --preset next --no-ci
bunx @ovt2/biome-react-kit init --preset strict --no-hooks --no-ci --skip-install

# Show usage
bunx @ovt2/biome-react-kit -h
bunx @ovt2/biome-react-kit --help
```

`init` is always safe to re-run: it never overwrites an existing
`biome.json`/`biome.jsonc`, script, `.husky/pre-commit`, or
`.github/workflows/biome.yml` — it just prints `!` warnings for whatever
already exists.

### `check` / `check:fix` / `ci` — run Biome without calling it directly

`biome-kit` is the short alias for `@ovt2/biome-react-kit`, installed
alongside the full name — use whichever you prefer:

```sh
# Lint/format-check the whole project
bunx biome-kit check

# Auto-fix what's fixable
bunx biome-kit check:fix

# CI-formatted output (GitHub Actions annotations), used by the generated workflow
bunx biome-kit ci

# Any of the three accept specific paths instead of defaulting to "."
bunx biome-kit check src/
bunx biome-kit check:fix src/components/Button.tsx
bunx biome-kit ci src/ tests/
```

These fail with a clear message instead of a stack trace if Biome isn't
installed yet in the current project (run `init` first).

### Scripts `init` writes into your `package.json`

```sh
npm run check       # or: pnpm check / yarn check / bun run check
npm run check:fix    # or: pnpm check:fix / yarn check:fix / bun run check:fix
```

These call the locally installed `biome` binary directly — no Bun required,
regardless of which package manager your project uses.

### Manual setup (without the CLI)

```sh
# Install Biome + the kit yourself
bun add -d -E @biomejs/biome @ovt2/biome-react-kit
npm install --save-dev --save-exact @biomejs/biome @ovt2/biome-react-kit
pnpm add --save-dev --save-exact @biomejs/biome @ovt2/biome-react-kit
yarn add --dev --exact @biomejs/biome @ovt2/biome-react-kit

# Then create biome.json by hand, extending whichever preset you want:
# { "extends": ["@ovt2/biome-react-kit/biome"] }          — base
# { "extends": ["@ovt2/biome-react-kit/biome/strict"] }   — strict
# { "extends": ["@ovt2/biome-react-kit/biome/next"] }     — next
```

### Manual pre-commit hook (without `init`)

```sh
bun add -d husky
bunx husky init
```

Replace the contents of `.husky/pre-commit` with:

```sh
./node_modules/.bin/biome check --write --staged --no-errors-on-unmatched --files-ignore-unknown=true
git update-index --again
```

Commits with unfixable errors (e.g. an unsafe-fix-only rule set to error)
will be blocked until you resolve them.

### Migrating an existing config

```sh
bunx biome migrate eslint --write
bunx biome migrate prettier --write
```
