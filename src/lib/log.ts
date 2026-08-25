/**
 * Console logging. Structured enough to grep, plain enough to read while
 * watching a run go by.
 */

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
} as const;

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

function paint(color: keyof typeof COLORS, s: string): string {
  return useColor ? `${COLORS[color]}${s}${COLORS.reset}` : s;
}

function stamp(): string {
  return paint('dim', new Date().toISOString().slice(11, 19));
}

function line(tag: string, color: keyof typeof COLORS, msg: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${paint('dim', JSON.stringify(extra))}`;
  process.stdout.write(`${stamp()} ${paint(color, tag.padEnd(5))} ${msg}${suffix}\n`);
}

export const log = {
  info: (msg: string, extra?: unknown) => line('info', 'blue', msg, extra),
  ok: (msg: string, extra?: unknown) => line('ok', 'green', msg, extra),
  warn: (msg: string, extra?: unknown) => line('warn', 'yellow', msg, extra),
  error: (msg: string, extra?: unknown) => line('error', 'red', msg, extra),
  phase: (msg: string, extra?: unknown) => line('phase', 'magenta', msg, extra),
  banner: (msg: string) => process.stdout.write(`\n${paint('bold', msg)}\n`),
};
