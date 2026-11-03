// Interactive "commit with steps" prompt (the Commitizen-style flow).
// Plain Node, readline only — no dependencies.
import { createInterface } from "node:readline/promises";
import { buildMessage, resolveOptions } from "./commit-lint.mjs";

const supportsColor = (stream) => stream.isTTY && !process.env.NO_COLOR;

/**
 * Ask the questions and return the finished message, or null if the user
 * chose not to commit. Throws if the input ends (Ctrl+C / Ctrl+D).
 */
export async function promptCommit({
  input = process.stdin,
  output = process.stderr,
  options,
} = {}) {
  const { types: TYPES, maxHeader: MAX_HEADER } = resolveOptions(options);
  const typeWidth = Math.max(...TYPES.map(([type]) => type.length));
  const rl = createInterface({ input, output });
  const c = supportsColor(output)
    ? {
        b: (s) => `\x1b[1m${s}\x1b[0m`,
        d: (s) => `\x1b[2m${s}\x1b[0m`,
        g: (s) => `\x1b[32m${s}\x1b[0m`,
        r: (s) => `\x1b[31m${s}\x1b[0m`,
      }
    : { b: (s) => s, d: (s) => s, g: (s) => s, r: (s) => s };
  const say = (text = "") => output.write(`${text}\n`);

  // Queue incoming lines so input that arrives early (pasted or piped) isn't
  // lost between questions, and so a closed input ends the prompt instead of
  // leaving it waiting forever.
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    rl.setPrompt(question);
    rl.prompt();
    const { value, done } = await lines.next();
    if (done) throw new Error("input closed");
    return value.trim();
  };

  try {
    say(c.b("\nCommit — step 1/7: type of change"));
    TYPES.forEach(([type, description], i) => {
      say(`  ${String(i + 1).padStart(2)}. ${c.g(type.padEnd(typeWidth))} ${c.d(description)}`);
    });
    let type;
    while (!type) {
      const answer = (await ask("Choose a type (number or name): ")).toLowerCase();
      type = TYPES.find(([name], i) => name === answer || String(i + 1) === answer)?.[0];
      if (!type) say(c.r("  Pick one of the listed types."));
    }

    say(c.b("\nStep 2/7: scope") + c.d("  (optional — the area you changed, e.g. auth, api, ui)"));
    let scope = "";
    for (;;) {
      scope = await ask("Scope (Enter to skip): ");
      if (!/[()]/.test(scope)) break;
      say(c.r("  Scope can't contain parentheses."));
    }

    say(c.b("\nStep 3/7: subject") + c.d("  (short, imperative: “add login form”, no period)"));
    let subject = "";
    for (;;) {
      subject = await ask("Subject: ");
      const headerLength = `${type}${scope ? `(${scope})` : ""}: ${subject}`.length;
      if (!subject) say(c.r("  The subject is required."));
      else if (subject.endsWith(".")) say(c.r("  Remove the trailing period."));
      else if (MAX_HEADER > 0 && headerLength > MAX_HEADER)
        say(c.r(`  Too long (${headerLength}/${MAX_HEADER}). Shorten it.`));
      else break;
    }

    say(c.b("\nStep 4/7: body") + c.d("  (optional — why, not what. Empty line to finish)"));
    const bodyLines = [];
    for (;;) {
      const line = await ask(bodyLines.length === 0 ? "Body (Enter to skip): " : "  …: ");
      if (line === "") break;
      bodyLines.push(line);
    }

    say(c.b("\nStep 5/7: breaking change?"));
    let breaking = "";
    if ((await ask("Does this break existing behaviour? (y/N): ")).toLowerCase().startsWith("y")) {
      while (!breaking) {
        breaking = await ask("Describe what breaks and how to migrate: ");
      }
    }

    say(c.b("\nStep 6/7: footer") + c.d("  (optional — issues this closes, e.g. “Closes #123”)"));
    const footer = await ask("Footer (Enter to skip): ");

    const message = buildMessage({
      type,
      scope,
      subject,
      body: bodyLines.join("\n"),
      breaking,
      footer,
    });
    say(c.b("\nStep 7/7: confirm"));
    say(c.d("─".repeat(40)));
    say(message);
    say(c.d("─".repeat(40)));
    const confirm = (await ask("Use this message? (Y/n): ")).toLowerCase();
    return confirm === "" || confirm.startsWith("y") ? message : null;
  } finally {
    rl.close();
  }
}
