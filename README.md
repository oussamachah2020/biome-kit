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
in your project, so you never have to know Biome's own flags:

```sh
bunx @ovt2/biome-react-kit check            # biome check .
bunx @ovt2/biome-react-kit check:fix        # biome check --write .
bunx @ovt2/biome-react-kit ci               # biome ci --reporter=github .
bunx @ovt2/biome-react-kit check src/foo.ts # pass specific paths through
```

These require Bun to invoke (same as `init`), since the CLI itself is a Bun
script. The `check`/`check:fix` scripts that `init` writes into your
`package.json` call `biome` directly instead, so `npm run check` (or
`pnpm`/`yarn run check`) stays Bun-free for everyday use — the CLI commands
above are a convenience for anyone who already has Bun and wants one
consistent command across projects.

### Manual setup

```sh
bun add -d -E @biomejs/biome @ovt2/biome-react-kit
```

Create `biome.json`:

```json
{ "extends": ["@ovt2/biome-react-kit/biome"] }
```

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

## Pre-commit hook

Run Biome on staged files before every commit so formatting and fixable lint
issues never reach the repo:

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

## Migrating from ESLint/Prettier

```sh
bunx biome migrate eslint --write
bunx biome migrate prettier --write
```
