// Conventional Commits rules. Plain Node (no Bun APIs, no dependencies):
// git hooks run this on every teammate's machine, whatever package manager
// or runtime they use.

export const TYPES = [
  ["feat", "A new feature"],
  ["fix", "A bug fix"],
  ["docs", "Documentation only"],
  ["style", "Formatting only, no code change"],
  ["refactor", "Code change that neither fixes a bug nor adds a feature"],
  ["perf", "A performance improvement"],
  ["test", "Adding or fixing tests"],
  ["build", "Build system or dependencies"],
  ["ci", "CI configuration"],
  ["chore", "Other changes that don't touch src or tests"],
  ["revert", "Reverts a previous commit"],
];

// Same defaults as Commitizen's `cz check --allowed-prefixes`: messages git or
// GitHub generate themselves.
export const DEFAULT_ALLOWED_PREFIXES = [
  "Merge",
  "Revert",
  "Pull request",
  "fixup!",
  "squash!",
  "amend!",
];

export const DEFAULT_MAX_HEADER = 100;
export const EXAMPLE = "feat(auth): add login form";

const HEADER = /^([a-z]+)(?:\(([^()]+)\))?(!)?: (.*)$/;
const LOOSE_HEADER = /^([A-Za-z]+)(?:\(([^()]*)\))?(!)?:/;

/**
 * Merge user options (from package.json "lintlane".commit or CLI flags) over
 * the defaults. `types` may be a list of names, [name, description] pairs, or
 * an object of { name: description }. A max header of 0 turns the limit off.
 */
export function resolveOptions(options = {}) {
  let types = TYPES;
  if (Array.isArray(options.types) && options.types.length > 0) {
    types = options.types.map((t) => (Array.isArray(t) ? [t[0], t[1] ?? ""] : [String(t), ""]));
  } else if (options.types && typeof options.types === "object" && !Array.isArray(options.types)) {
    types = Object.entries(options.types).map(([name, description]) => [name, String(description)]);
  }
  const limit = Number(options.messageLengthLimit ?? options.maxHeader);
  return {
    types,
    maxHeader: Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_MAX_HEADER,
    allowedPrefixes: [
      ...DEFAULT_ALLOWED_PREFIXES,
      ...(Array.isArray(options.allowedPrefixes) ? options.allowedPrefixes : []),
    ],
    allowAbort: Boolean(options.allowAbort),
  };
}

/** Drop git's "# ..." comment lines and surrounding blank space. */
export function cleanMessage(raw) {
  return raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

export function validateMessage(raw, options) {
  const opts = resolveOptions(options);
  const message = cleanMessage(raw);
  if (!message) {
    return opts.allowAbort
      ? { valid: true, errors: [], skipped: true }
      : { valid: false, errors: ["The commit message is empty."] };
  }

  const [header, ...rest] = message.split("\n");
  if (opts.allowedPrefixes.some((prefix) => header.startsWith(prefix))) {
    return { valid: true, errors: [], skipped: true };
  }

  const errors = [];
  const typeNames = opts.types.map(([type]) => type);
  const match = HEADER.exec(header);

  if (!match) {
    const loose = LOOSE_HEADER.exec(header);
    if (loose && loose[1] !== loose[1].toLowerCase()) {
      errors.push(`The type "${loose[1]}" must be lowercase ("${loose[1].toLowerCase()}").`);
    } else if (loose && header.slice(loose[0].length, loose[0].length + 1) !== " ") {
      errors.push('Put a space after the colon: "type: subject".');
    } else {
      errors.push(`The header must look like "type(scope): subject", e.g. "${EXAMPLE}".`);
    }
  } else {
    const [, type, , , subject] = match;
    if (!typeNames.includes(type)) {
      errors.push(`Unknown type "${type}". Use one of: ${typeNames.join(", ")}.`);
    }
    if (!subject.trim()) errors.push("The subject after the colon can't be empty.");
    if (subject.trim().endsWith(".")) errors.push("The subject shouldn't end with a period.");
  }

  if (opts.maxHeader > 0 && header.length > opts.maxHeader) {
    errors.push(`The header is ${header.length} characters; keep it under ${opts.maxHeader}.`);
  }
  if (rest.length > 0 && rest[0].trim() !== "") {
    errors.push("Leave a blank line between the header and the body.");
  }

  return { valid: errors.length === 0, errors };
}

/** Build the final message from the prompt's answers. */
export function buildMessage({ type, scope, subject, body, breaking, footer }) {
  const header = `${type}${scope ? `(${scope})` : ""}${breaking ? "!" : ""}: ${subject}`;
  const parts = [header];
  if (body) parts.push(body);
  const footers = [];
  if (breaking) footers.push(`BREAKING CHANGE: ${breaking}`);
  if (footer) footers.push(footer);
  if (footers.length > 0) parts.push(footers.join("\n"));
  return parts.join("\n\n");
}

export function explainFailure(errors, options) {
  const { types } = resolveOptions(options);
  return [
    "",
    "✘ Commit message rejected",
    "",
    ...errors.map((error) => `  • ${error}`),
    "",
    "  Format:   type(scope): subject",
    `  Example:  ${EXAMPLE}`,
    `  Types:    ${types.map(([type]) => type).join(", ")}`,
    "",
    "  Not sure? Run the guided prompt:  npx lintlane commit",
    "  (or just `git commit` with no -m, and you'll be asked step by step)",
    "",
  ].join("\n");
}
