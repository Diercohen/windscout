// Connecting to the working connections a scan found, without a terminal (windscout connect in a script): one line each.
// In a terminal, the results screen (results.ts) connects and keeps you connected instead.
import { attempt, disconnect, target, type Result } from "../probe.js";
import { duration, now } from "../time.js";
import { label } from "../watch.js";
import { command } from "./report.js";
import { cyan, green, yellow } from "./text.js";

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
    console.log(`\n${k + 1}/${list.length} ${label(list[i])}`);
    if (await connectTo(list[i], timeout, stopped)) return i;
  }
  return -1;
}
