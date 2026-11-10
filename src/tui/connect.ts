// Connecting to the working connections a scan found, and keeping you connected: with a terminal, windscout then stays and
// watches the connection, and when it drops, connects again.
import { emitKeypressEvents, type Key } from "node:readline";
import { attempt, disconnect, target, type Result } from "../probe.js";
import { duration, now } from "../time.js";
import { appIo, Watch, WATCH_MISSES, WATCH_RETRY } from "../watch.js";
import { connectState } from "../windscribe.js";
import { command } from "./report.js";
import { out } from "./terminal.js";
import { cyan, dim, green, red, yellow } from "./text.js";

const name = (r: Result) => `${r.location || r.query} over ${r.protocol}`;

/** Runs a result's connect command and checks it as the scan does: connected, on its port, with internet through it.
 * True once it is; otherwise disconnects (and waits until the app has), so the next connect isn't swallowed */
async function connectTo(r: Result, timeout: number, stopped?: () => boolean): Promise<boolean> {
  console.log(cyan(command(r)));
  const t = now(), { status, location } = await attempt(target(r), r.protocol, { timeout, speedTest: false, stopped });
  if (status === "ok") return console.log(green(`Connected: ${location}`)), true;
  console.log(yellow(`${status} after ${duration(now() - t)}`));
  await disconnect();
  return false;
}

/** Connects to list[from], or when it doesn't connect, to the next ones in turn, around to the one before it.
 * The index of the one that connected; -1 when none did */
export async function connectFrom(list: Result[], from: number, timeout: number, stopped = () => false): Promise<number> {
  for (let k = 0; k < list.length && !stopped(); k++) {
    const i = (from + k) % list.length;
    console.log(`\n${k + 1}/${list.length} ${name(list[i])}`);
    if (await connectTo(list[i], timeout, stopped)) return i;
  }
  return -1;
}

/** Watches the connection to list[i] (Watch) until q, or until you disconnect or switch in the app (needs a terminal), with a
 * status line, and a timestamped line for each drop. q leaves the VPN as it is */
export async function watch(list: Result[], i: number, timeout: number): Promise<void> {
  let live = true; // the status line is on screen: not while connecting again
  // the status line, redrawn in place; wrapping off, so a narrow terminal cuts it instead of breaking the redraw
  const line = (text: string) => out.write(`\r\x1b[2K\x1b[?7l${text}\x1b[?7h`);
  const log = (text: string) => (line(""), console.log(`${dim(new Date().toTimeString().slice(0, 8))} ${text}`));
  const w: Watch = new Watch(list, i, {
    ...appIo,
    connect: async (from) => {
      const j = await connectFrom(list, from, timeout, () => w.stopped);
      live = j >= 0;
      return j;
    },
  }, {
    dropped: (why, lasted) => ((live = false), log(`${red("✗")} ${name(list[w.i])}: ${why} · it lasted ${duration(lasted)}`)),
    none: () => log(yellow(`none of the ${list.length} connects now: trying them all again in ${duration(WATCH_RETRY)} · q stops watching`)),
  });
  const draw = () => live && line(`${w.misses ? yellow("●") : green("●")} ${name(list[w.i])} · up ${duration(now() - w.since)} · ${
    w.misses ? `no answer ${w.misses}/${WATCH_MISSES}` : w.ms === null ? "checking" : `${Math.round(w.ms)} ms`}${
    w.drops ? ` · reconnected ${w.drops}×` : ""}  ${dim("q stops watching")}`);
  const onKey = (_: string | undefined, key: Key = {}) => {
    if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) w.stop();
  };

  console.log(dim("\nwatching: when the connection drops, windscout connects again · q, or disconnecting in the app, stops it"));
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", onKey).resume();
  const timer = setInterval(draw, 1000);
  try {
    draw();
    await w.run();
  } finally {
    clearInterval(timer);
    line("");
    process.stdin.off("keypress", onKey);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  console.log(`stopped watching${w.why ? `: ${w.why}` : ""} · ${(await connectState()) || "not connected"}`);
}
