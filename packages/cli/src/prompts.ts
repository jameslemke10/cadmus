/**
 * Tiny interactive prompts using raw-mode stdin. No deps.
 *
 *   selectFromList — arrow-key menu with a default selection.
 *   readSecret     — like readline.question, but echoes asterisks.
 *
 * Both fall back gracefully when stdin isn't a TTY (e.g. running under a
 * pipe or non-interactive CI) — selectFromList accepts a numbered choice
 * via readline, and readSecret asks readline but warns it'll be visible.
 */

import { createInterface } from "node:readline/promises";

export interface SelectOption {
  label: string;
  value: string;
  /** Optional dimmed text after the label, e.g. a URL. */
  hint?: string;
}

const ANSI = {
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  clearLine: "\x1b[2K\r",
  up: (n: number) => `\x1b[${n}A`,
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  reset: "\x1b[0m",
};

export async function selectFromList(args: {
  prompt: string;
  options: SelectOption[];
  defaultIndex?: number;
}): Promise<string> {
  const { prompt, options, defaultIndex = 0 } = args;
  if (options.length === 0) throw new Error("selectFromList: no options");

  if (!process.stdin.isTTY) {
    return fallbackNumberedSelect(prompt, options, defaultIndex);
  }

  return new Promise<string>((resolve) => {
    let index = Math.max(0, Math.min(defaultIndex, options.length - 1));
    let firstRender = true;

    const render = (): void => {
      // After the first render, jump cursor back up to overwrite previous lines.
      if (!firstRender) {
        process.stdout.write(ANSI.up(options.length));
      } else {
        firstRender = false;
      }
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const isSelected = i === index;
        const marker = isSelected ? "▶" : " ";
        const label = isSelected ? `${ANSI.bold}${opt.label}${ANSI.reset}` : opt.label;
        const hint = opt.hint ? `  ${ANSI.dim}${opt.hint}${ANSI.reset}` : "";
        process.stdout.write(`${ANSI.clearLine}  ${marker} ${label}${hint}\n`);
      }
    };

    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write(ANSI.showCursor);
    };

    const onData = (buf: Buffer): void => {
      const key = buf.toString("utf8");
      if (key === "\x1b[A" || key === "k") {
        index = (index - 1 + options.length) % options.length;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        index = (index + 1) % options.length;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        // Print a final summary line so there's a record of the choice.
        process.stdout.write(
          `  ${ANSI.green}✓${ANSI.reset} ${options[index].label}\n`,
        );
        resolve(options[index].value);
      } else if (key === "\x03") {
        cleanup();
        process.stdout.write("\n");
        process.exit(130);
      }
    };

    process.stdout.write(`${prompt}\n`);
    process.stdout.write(`${ANSI.dim}  (↑/↓ to move, Enter to select)${ANSI.reset}\n`);
    process.stdout.write(ANSI.hideCursor);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}

async function fallbackNumberedSelect(
  prompt: string,
  options: SelectOption[],
  defaultIndex: number,
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(prompt);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIndex ? "▶" : " ";
    const hint = options[i].hint ? `  (${options[i].hint})` : "";
    console.log(`  ${marker} ${i + 1}) ${options[i].label}${hint}`);
  }
  const raw = (await rl.question(`  Choice [${defaultIndex + 1}] `)).trim();
  rl.close();
  const n = raw ? parseInt(raw, 10) - 1 : defaultIndex;
  if (Number.isNaN(n) || n < 0 || n >= options.length) {
    return options[defaultIndex].value;
  }
  return options[n].value;
}

/**
 * Read a value without echoing it to the terminal. Echoes `*` per character
 * so the user can see they're typing something.
 */
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // No TTY — fall back to readline. Caller has been warned.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(prompt);
    rl.close();
    return ans.trim();
  }

  return new Promise<string>((resolve) => {
    process.stdout.write(prompt);
    let buf = "";

    const cleanup = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
    };

    const onData = (chunk: Buffer): void => {
      const str = chunk.toString("utf8");
      for (const ch of str) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buf);
          return;
        } else if (ch === "\x7f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (ch === "\x03") {
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch >= " " && ch <= "~") {
          buf += ch;
          process.stdout.write("*");
        }
        // Ignore everything else (escape sequences, etc.).
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
