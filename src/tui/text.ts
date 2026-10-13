// String helpers for the terminal: ANSI colors, visible width, padding.

const plain = () => process.env.NO_COLOR || !process.stdout.isTTY;
export const color = (code: number | string, s: string) => (plain() ? s : `\x1b[${code}m${s}\x1b[0m`);
export const bold = (s: string) => color(1, s);
export const dim = (s: string) => color(2, s);
export const red = (s: string) => color(31, s);
export const green = (s: string) => color(32, s);
export const yellow = (s: string) => color(33, s);
export const cyan = (s: string) => color(36, s);
// underline off (24) instead of a full reset, so it nests inside dim/bold
export const under = (s: string) => (plain() ? s : `\x1b[4m${s}\x1b[24m`);

/** A number with fixed decimals, "-" when missing */
export const fmt = (v: number | null, digits: number) => (v === null ? "-" : v.toFixed(digits));

// visible width: ANSI codes take no space; flags and emoji (🔍) take 2 columns. text symbols like ▶ ★ stay 1
export const vw = (s: string) =>
  [...s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F300}-\u{1FAFF}]/gu, "xx")].length;

export type Align = "left" | "right" | "center";

/** Pads s with spaces to n visible columns */
export function pad(s: string, n: number, align: Align = "left"): string {
  const gap = Math.max(0, n - vw(s));
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return align === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}
