/**
 * Minimal readline-based prompts: `ask`, `confirm`, `select`. No framework,
 * no raw-mode key trapping — numbered-list selectors keep the install flow
 * predictable across terminals and TTY edge cases.
 *
 * TTY rules:
 *   - When `process.stdin.isTTY` is false (CI, pipe), we are non-interactive.
 *     Each prompt returns its default (or throws if no default is available).
 */

import readline from 'node:readline/promises';

import { BOLD, DIM, RESET, TEXT } from './style.js';

function isInteractive(): boolean {
  // Treat undefined isTTY as non-interactive — same as the legacy behavior.
  return Boolean(process.stdin.isTTY);
}

interface AskOpts {
  default?: string;
  /**
   * If true (and interactive), do not echo the typed characters. Used for
   * the token prompt. We don't bother with raw-mode masking (`*` per char)
   * — silence is enough.
   */
  silent?: boolean;
  /** If true, reject empty input even when no default is provided. */
  required?: boolean;
}

/**
 * Read one line of text. With `default`, an empty response returns the
 * default. With `silent` (interactive only), keystrokes are not echoed.
 */
export async function ask(prompt: string, opts: AskOpts = {}): Promise<string> {
  if (!isInteractive()) {
    if (typeof opts.default === 'string') return opts.default;
    if (opts.required) {
      throw new Error(`non-interactive: missing required input (${prompt.trim()})`);
    }
    return '';
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix =
    typeof opts.default === 'string' && opts.default.length > 0
      ? ` ${DIM}(default: ${opts.default})${RESET}`
      : '';
  const full = `${BOLD}?${RESET} ${prompt}${suffix} `;

  let answer: string;
  if (opts.silent) {
    // Suppress the typed characters. `_writeToOutput` is an undocumented but
    // stable interface in readline since Node 10. If anything changes we
    // fall back to plain echo — the prompt still works.
    const w = rl as unknown as { _writeToOutput?: (s: string) => void };
    const origWrite = w._writeToOutput?.bind(rl);
    w._writeToOutput = (chunk: string) => {
      if (origWrite) origWrite(chunk.includes(prompt) ? chunk : '');
    };
    try {
      answer = await rl.question(full);
    } finally {
      if (origWrite) w._writeToOutput = origWrite;
      // readline doesn't print a newline after a silent prompt — add one.
      process.stdout.write('\n');
    }
  } else {
    answer = await rl.question(full);
  }
  rl.close();

  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    if (typeof opts.default === 'string') return opts.default;
    if (opts.required) {
      throw new Error(`required input was empty (${prompt.trim()})`);
    }
  }
  return trimmed;
}

/**
 * Yes/no prompt. `defaultYes` controls both the default response on empty
 * input and the `(Y/n)` vs `(y/N)` hint shown to the user.
 */
export async function confirm(prompt: string, defaultYes = true): Promise<boolean> {
  if (!isInteractive()) return defaultYes;

  const hint = defaultYes ? `${DIM}(Y/n)${RESET}` : `${DIM}(y/N)${RESET}`;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${BOLD}?${RESET} ${prompt} ${hint} `)).trim().toLowerCase();
  rl.close();

  if (answer === '') return defaultYes;
  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;
  // Anything else: be conservative — treat as default.
  return defaultYes;
}

export interface SelectChoice<T extends string> {
  value: T;
  label: string;
  /** Optional dim suffix shown after the label (e.g. "(detected)"). */
  hint?: string;
  /** If true, the choice cannot be selected; used to dim "(not detected)". */
  disabled?: boolean;
}

/**
 * Numbered-list selector. Returns the selected `value`. Defaults to the
 * first non-disabled choice on empty input. In non-interactive mode,
 * returns the default without prompting.
 */
export async function select<T extends string>(
  prompt: string,
  choices: readonly SelectChoice<T>[]
): Promise<T> {
  if (choices.length === 0) throw new Error('select: choices must be non-empty');
  const defaultIdx = Math.max(
    0,
    choices.findIndex((c) => !c.disabled)
  );

  if (!isInteractive()) {
    return choices[defaultIdx].value;
  }

  console.log(`${BOLD}?${RESET} ${prompt}`);
  choices.forEach((c, i) => {
    const num = `${i + 1}`;
    const tag = c.disabled ? `${DIM}${num})${RESET}` : `${TEXT}${num})${RESET}`;
    const label = c.disabled ? `${DIM}${c.label}${RESET}` : c.label;
    const hint = c.hint ? `  ${DIM}${c.hint}${RESET}` : '';
    const arrow = i === defaultIdx ? `${TEXT}❯${RESET} ` : '  ';
    console.log(`  ${arrow}${tag} ${label}${hint}`);
  });

  while (true) {
    const raw = await ask(`Select [1-${choices.length}]`, { default: String(defaultIdx + 1) });
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= choices.length) {
      const choice = choices[n - 1];
      if (choice.disabled) {
        process.stdout.write(`${DIM}(${choice.label} is not available)${RESET}\n`);
        continue;
      }
      return choice.value;
    }
    process.stdout.write(`${DIM}Please enter a number between 1 and ${choices.length}.${RESET}\n`);
  }
}
