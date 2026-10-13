// The terminal: full-screen mode, keyboard and mouse input, drawing frames.
import { spawn } from "node:child_process";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { vw } from "./text.js";

const REPO_URL = "https://github.com/Diercohen/windscout";
// OSC 8 makes the text a link in terminals that support it; clicks we receive ourselves are handled in onData
export const repoLink = `\x1b]8;;${REPO_URL}\x1b\\${REPO_URL}\x1b]8;;\x1b\\`;

export const out = process.stdout;
// stdin minus mouse reports: readline would split those into stray keypresses ("0", ";", "M"…).
// Emits "keypress" (str, key) like stdin would, and "mouse" (Mouse)
export const input = new PassThrough();
emitKeypressEvents(input);

/** A mouse report, in 0-based screen cells */
export interface Mouse {
  button: number; // 0 = left, 64/65 = wheel up/down
  x: number;
  y: number;
  press: boolean; // false = release
}

let fullscreen = false;
let link: { y: number; x: number } | null = null; // where draw() last put the repo link

const openUrl = (url: string) =>
  spawn(({ darwin: "open", win32: "explorer" } as Partial<Record<NodeJS.Platform, string>>)[process.platform] ?? "xdg-open",
    [url], { stdio: "ignore", detached: true })
    .on("error", () => {}).unref();

// SGR mouse report: ESC [ < button ; col ; row (M = press, m = release)
// ponytail: assumes a report never straddles two reads, true for terminals in practice
const onData = (buf: Buffer) => {
  const rest = buf.toString().replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, b: string, x: string, y: string, kind: string) => {
    const m: Mouse = { button: Number(b), x: Number(x) - 1, y: Number(y) - 1, press: kind === "M" };
    if (link && m.press && m.button === 0 && m.y === link.y && m.x >= link.x && m.x < link.x + REPO_URL.length) openUrl(REPO_URL);
    input.emit("mouse", m);
    return "";
  });
  if (rest) input.write(rest);
};

/** Alternate screen, cursor hidden, mouse reports on, raw keys */
export function enterScreen(): void {
  if (fullscreen) return;
  fullscreen = true;
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h"); // alternate screen, hide cursor, mouse on
  process.stdin.setRawMode(true);
  process.stdin.on("data", onData);
  process.stdin.resume();
}

/** Back to the normal screen; drops every key and mouse listener */
export function leaveScreen(): void {
  if (!fullscreen) return;
  fullscreen = false;
  process.stdin.setRawMode(false);
  process.stdin.off("data", onData);
  process.stdin.pause();
  input.removeAllListeners("keypress");
  input.removeAllListeners("mouse");
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
}
process.on("exit", leaveScreen);

/** Redraws in place, centered: home, each line cleared to its end, then clear below (no flicker). Returns the top-left corner */
export function draw(lines: string[]): { left: number; top: number } {
  const cols = out.columns || 80, rows = out.rows || 24;
  const w = Math.max(...lines.map(vw));
  const left = " ".repeat(Math.max(0, Math.floor((cols - w) / 2)));
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  const screen = [...Array<string>(top).fill(""), ...lines.map((l) => left + l)].slice(0, rows);
  const i = screen.findIndex((l) => l.includes(REPO_URL));
  link = i < 0 ? null : { y: i, x: vw(screen[i].slice(0, screen[i].indexOf("\x1b]8;;"))) };
  // a timer tick can land after leaveScreen() (force quit, crash): don't paint over the normal screen
  if (fullscreen) out.write("\x1b[H" + screen.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
  return { left: left.length, top };
}
