// One attempt: connect to a location over a protocol, measure through the tunnel, disconnect.
// windscout connect makes the same attempt and, when it works, stays connected.
import { latencyMs, SPEED_SECONDS, speedMbps } from "./measure.js";
import { now, sleep } from "./time.js";
import { connectState, windscribe } from "./windscribe.js";

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
  steady?: boolean; // stop at the first: also check the connection holds up (holdsUp), else it's "unreliable"; measures speed too
  stopped?: () => boolean; // polled while connecting; true gives up with "interrupted"
  onStep?: (text: string) => void; // what the probe is doing, for the live view
  // runs the measurements; a parallel scan passes a lock: its containers share one connection and would skew each other
  measure?: (fn: () => Promise<void>) => Promise<void>;
}

// Stop at the first ends the scan at one connection, so that one has to last: a tunnel can connect and then be cut or throttled
// once traffic flows. It counts once it downloads at MIN_MBPS or more, then stays up with internet for STEADY_CHECKS round trips
export const MIN_MBPS = 1;
const STEADY_CHECKS = 5, STEADY_GAP = 2; // seconds between the round trips
// shortcut: guesses ~5 s to connect and the whole speed test; refine from real runs
export const STEADY_SECONDS = 5 + SPEED_SECONDS + STEADY_CHECKS * (STEADY_GAP + 0.5);

/** Whether stop at the first can stop at this result: it worked, held up, and is fast enough for real use */
export const reliable = (r: Result) => r.status === "ok" && (r.speedMbps ?? 0) >= MIN_MBPS;

// "Connected: Miami - Vice" → "Miami - Vice"
const place = (state: string) => state.split(":").slice(1).join(":").trim();

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
  { timeout, speedTest, steady = false, stopped = () => false, onStep = () => {}, measure = (fn) => fn() }: ProbeOptions): Promise<Result> {
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
  let measured = false, holds = true;
  await measure(async () => {
    // a stopping scan waits for no more measurements: a parallel scan's containers measure one at a time, so they'd queue up
    if (stopped()) return;
    measured = true;
    onStep(`measuring latency · ${r.location}`);
    r.latencyMs = await latencyMs();
    if (r.latencyMs === null) return;
    if (speedTest || steady) {
      onStep(`measuring speed · ${r.location}`);
      r.speedMbps = await speedMbps();
    }
    if (steady) holds = await holdsUp(r.location, onStep);
  });
  if (!measured) return end("interrupted");
  return end(r.latencyMs === null ? "no internet" : holds ? "ok" : "unreliable");
}

/** Whether the connection stays up with internet through it: STEADY_CHECKS round trips, STEADY_GAP seconds apart, each with a retry */
async function holdsUp(location: string, onStep: (text: string) => void): Promise<boolean> {
  for (let i = 1; i <= STEADY_CHECKS; i++) {
    onStep(`checking it holds up ${i}/${STEADY_CHECKS} · ${location}`);
    await sleep(STEADY_GAP * 1000);
    if (!(await connectState()).startsWith("Connected") || (await latencyMs(2)) === null) return false;
  }
  return true;
}

/** The attempts that worked, best first: fastest, then lowest latency */
export const sortOk = (results: Result[]) =>
  results.filter((r) => r.status === "ok")
    .sort((x, y) => (y.speedMbps ?? 0) - (x.speedMbps ?? 0) || (x.latencyMs ?? 0) - (y.latencyMs ?? 0));
