// Drawing blocks, with rounded box-drawing borders: box, grid (table), progress bar.
import { bold, color, dim, pad, vw, type Align } from "./text.js";

const border = dim;

/** Box around lines; a null line draws a ├──┤ divider. title and right sit in the top border */
export function box(lines: (string | null)[], { title = "", right = "", width = 0 } = {}): string[] {
  const inner = Math.max(width, ...lines.map((l) => (l === null ? 0 : vw(l))), vw(title) + vw(right) + 6);
  const left = title ? border("─ ") + title + " " : "";
  const tail = right ? " " + right + border(" ─") : "";
  const fill = inner + 2 - vw(left) - vw(tail);
  return [
    border("╭") + left + border("─".repeat(fill)) + tail + border("╮"),
    ...lines.map((l) => (l === null ? border("├" + "─".repeat(inner + 2) + "┤") : border("│") + " " + pad(l, inner) + " " + border("│"))),
    border("╰" + "─".repeat(inner + 2) + "╯"),
  ];
}

export interface Column {
  title: string;
  align?: Align;
}

export interface GridOptions {
  caption?: string; // a row spanning all columns, on top inside the same border
  captionRight?: string; // right-aligned in the caption row
  minWidth?: number;
  stretch?: number; // index of the column that absorbs extra width (default: the last)
}

/** Bordered table */
export function grid(cols: Column[], rows: string[][], { caption, captionRight = "", minWidth = 0, stretch = cols.length - 1 }: GridOptions = {}): string[] {
  const w = cols.map((c, i) => Math.max(vw(c.title), ...rows.map((r) => vw(r[i]))));
  const total = () => w.reduce((a, n) => a + n + 3, 1);
  if (caption !== undefined) w[stretch] += Math.max(0, vw(caption) + vw(captionRight) + 5 - total());
  w[stretch] += Math.max(0, minWidth - total());
  const rule = (l: string, m: string, r: string) => border(l + w.map((n) => "─".repeat(n + 2)).join(m) + r);
  const row = (cells: string[]) => border("│") + cells.map((c, i) => " " + pad(c, w[i], cols[i].align) + " ").join(border("│")) + border("│");
  const out: string[] = [];
  if (caption !== undefined) {
    const inner = total() - 4;
    out.push(border("╭" + "─".repeat(total() - 2) + "╮"),
      border("│") + " " + pad(caption, inner - vw(captionRight)) + captionRight + " " + border("│"),
      rule("├", "┬", "┤"));
  } else out.push(rule("╭", "┬", "╮"));
  out.push(row(cols.map((c) => bold(c.title))), rule("├", "┼", "┤"), ...rows.map(row), rule("╰", "┴", "╯"));
  return out;
}

/** s, indented to sit centered in width columns */
export const centerIn = (s: string, width: number) => " ".repeat(Math.max(0, Math.floor((width - vw(s)) / 2))) + s;

/** Gradient bar (cyan → green) with eighth-block precision on the leading edge */
export function bar(fraction: number, width: number): string {
  const parts = " ▏▎▍▌▋▊▉";
  const cells = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(cells);
  const palette = [45, 44, 43, 42, 41, 47, 48, 49, 83, 82];
  const shade = (i: number) => palette[Math.floor((i / width) * palette.length)];
  let s = "";
  for (let i = 0; i < full; i++) s += color(`38;5;${shade(i)}`, "█");
  if (full < width) {
    const p = parts[Math.floor((cells - full) * 8)];
    s += p === " " ? dim("░") : color(`38;5;${shade(full)}`, p);
    s += dim("░".repeat(width - full - 1));
  }
  return s;
}
