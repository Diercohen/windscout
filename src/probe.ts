// One attempt: connect to a location over a protocol, measure through the tunnel, disconnect.
// windscout connect makes the same attempt and, when it works, stays connected.
import { latencyMs, SPEED_SECONDS, speedMbps } from "./measure.js";
import { duration, now, sleep } from "./time.js";
import { connectState, place, windscribe } from "./windscribe.js";

export type Status = "ok" | "timeout" | "failed" | "key limit" | "no such port" | "no such location" | "no internet" | "unreliable" | "interrupted";

export interface Result {
  query: string; // what was asked for: a country code, city or nickname
  protocol: string; // as passed to the CLI, optionally with a port: "tcp:443"
  location: string; // where the app connected: "Frankfurt - Castle"
  connectS: number | null; // seconds until connected
  latencyMs: number | null;
  speedMbps: number | null; // null when the speed test is off
  status: Status;
}

export interface ProbeOptions {
  timeout: number; // seconds to wait for the connection
  speedTest: boolean; // also measure download speed
  // stop at the first: seconds the connection has to hold up (holdsUp), then a speed test again and a reconnect, else it's
  // "unreliable"; measures speed too. 0: none of that
  steady?: number;
  stopped?: () => boolean; // polled while connecting and holding up; true gives up with "interrupted"
  onStep?: (text: string) => void; // what the probe is doing, for the live view
  // runs the measurements; a parallel scan passes a lock: its containers share one connection and would skew each other
  measure?: (fn: () => Promise<void>) => Promise<void>;
}

// Stop at the first ends the scan at one connection, so that one has to last: a tunnel can connect and then be cut or throttled
// once traffic flows, or refuse the next connection, which is the one the user makes. So it counts once it downloads at
// MIN_MBPS or more, holds up (holdsUp), downloads at MIN_MBPS or more again, and connects again as the user will
export const MIN_MBPS = 1;
const STEADY_GAP = 2; // seconds between the hold's round trips
// shortcut: guesses ~5 s to connect, the whole speed tests and ~10 s to reconnect; refine from real runs
export const steadySeconds = (hold: number) => 5 + SPEED_SECONDS + hold + SPEED_SECONDS + 10;

/** Whether stop at the first can stop at this result: it worked, held up, and is fast enough for real use */
export const reliable = (r: Result) => r.status === "ok" && (r.speedMbps ?? 0) >= MIN_MBPS;

/** Whether a hold's round trips so far (true: got through) still hold up: never 2 lost in a row (an outage), and no more
 * than 1 in 10 lost (too lossy to use); fewer than 10 may lose 1 */
export const holding = (trips: boolean[]) =>
  !trips.some((ok, i) => !ok && trips[i - 1] === false) && trips.filter((ok) => !ok).length * 10 <= Math.max(10, trips.length);

// nickname pins the exact datacenter: what the user connects with, and what the reconnect checks
export const target = (r: Pick<Result, "location" | "query">) => r.location.split(" - ").at(-1) || r.query;

export async function probe(query: string, protocol: string, options: ProbeOptions): Promise<Result> {
  try {
    return await attempt(query, protocol, options);
  } finally {
    options.onStep?.("disconnecting");
    await disconnect();
  }
}

/** Disconnects, and waits until the app has */
export async function disconnect(): Promise<void> {
  await windscribe("disconnect");
  // the CLI's disconnect can return while the app is still tearing down (it does after a timed-out connect);
  // a connect sent then is swallowed and the next attempt reads as an instant "failed", so wait it out
  for (let i = 0; i < 30 && (await connectState()) === "Disconnecting"; i++) await sleep(1000);
}

/** Connects and measures through the tunnel, as probe does, but leaves the connection as it is: up when it worked */
export async function attempt(query: string, protocol: string,
  { timeout, speedTest, steady = 0, stopped = () => false, onStep = () => {}, measure = (fn) => fn() }: ProbeOptions): Promise<Result> {
  const r: Omit<Result, "status"> = { query, protocol, location: "", connectS: null, latencyMs: null, speedMbps: null };
  const end = (status: Status): Result => ({ ...r, status });
  onStep("connecting");
  await windscribe("connect", "-n", query, protocol);
  const t = now();
  for (;;) {
    if (stopped()) return end("interrupted");
    if (now() - t >= timeout) return end("timeout");
    const s = await connectState();
    if (s.startsWith("Connecting:")) r.location = place(s);
    else if (s.startsWith("Connected")) {
      if (s.includes(":")) r.location = place(s);
      r.connectS = now() - t;
      break;
    } else if (s.includes("does not exist")) return end("no such location");
    // Windscribe refused this app another WireGuard key for the account: says nothing about this network
    else if (s.includes("WireGuard key limit") && now() - t > 3) return end("key limit");
    else if (s === "Disconnected" && now() - t > 3) return end("failed");
    onStep(`connecting ${r.location}`.trim());
    await sleep(1000);
  }
  // a port the app doesn't offer for the protocol: it connects on the protocol's default instead, so this port wasn't tried
  const port = protocol.split(":")[1], shown = (await windscribe("status")).match(/^Protocol: .*:(\d+)\s*$/m)?.[1];
  if (port && shown && shown !== port) return end("no such port");
  let status = "interrupted" as Status, reconnect = false; // reconnect: it passed the other checks, so the reconnect is next
  await measure(async () => {
    // a stopping scan waits for no more measurements: a parallel scan's containers measure one at a time, so they'd queue up
    if (stopped()) return;
    onStep(`measuring latency · ${r.location}`);
    r.latencyMs = await latencyMs();
    if (r.latencyMs === null) return void (status = "no internet");
    if (speedTest || steady) {
      onStep(`measuring speed · ${r.location}`);
      r.speedMbps = await speedMbps();
    }
    status = "ok";
    const first = r.speedMbps ?? 0;
    if (!steady || first < MIN_MBPS) return; // the scan never stops at a slower one, so it goes without the checks
    const held = await holdsUp(steady, r.location, stopped, onStep);
    if (held !== true) return void (status = held === "interrupted" ? held : "unreliable");
    onStep(`measuring speed again · ${r.location}`);
    r.speedMbps = Math.min(first, (await speedMbps()) ?? 0); // throttled once traffic flowed: the slower one counts
    if (r.speedMbps < MIN_MBPS) return void (status = "unreliable");
    reconnect = true;
  });
  if (!reconnect) return end(status);
  // after its turn to measure: the next container can start while this one connects again, as the user will
  onStep(`reconnecting · ${r.location}`);
  await disconnect();
  const { status: again } = await attempt(target(r), protocol, { timeout, speedTest: false, stopped });
  return end(again === "ok" || again === "interrupted" ? again : "unreliable");
}

/** Whether the connection holds up for seconds: connected to the same server the whole time, with a round trip through it
 * every STEADY_GAP seconds, as long as they're holding(); "interrupted" when the scan stops first */
async function holdsUp(seconds: number, location: string, stopped: () => boolean, onStep: (text: string) => void): Promise<boolean | "interrupted"> {
  const trips: boolean[] = [];
  for (const t = now(); now() - t < seconds; ) {
    if (stopped()) return "interrupted";
    onStep(`checking it holds up ${duration(now() - t)}/${duration(seconds)} · ${location}`);
    await sleep(STEADY_GAP * 1000);
    const s = await connectState(); // dropped, or the app moved it to another server
    if (!s.startsWith("Connected") || (location && s.includes(":") && place(s) !== location)) return false;
    trips.push((await latencyMs(1)) !== null);
    if (!holding(trips)) return false;
  }
  return true;
}

/** The attempts that worked, best first: fastest, then lowest latency */
export const sortOk = (results: Result[]) =>
  results.filter((r) => r.status === "ok")
    .sort((x, y) => (y.speedMbps ?? 0) - (x.speedMbps ?? 0) || (x.latencyMs ?? 0) - (y.latencyMs ?? 0));
