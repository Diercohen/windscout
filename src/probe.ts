// One attempt: connect to a location over a protocol, measure through the tunnel, disconnect.
import { latencyMs, speedMbps } from "./measure.js";
import { now, sleep } from "./time.js";
import { connectState, windscribe } from "./windscribe.js";

export type Status = "ok" | "timeout" | "failed" | "key limit" | "no such location" | "no internet" | "interrupted";

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
  stopped?: () => boolean; // polled while connecting; true gives up with "interrupted"
  onStep?: (text: string) => void; // what the probe is doing, for the live view
  // runs the measurements; a parallel scan passes a lock: its containers share one connection and would skew each other
  measure?: (fn: () => Promise<void>) => Promise<void>;
}

// "Connected: Miami - Vice" → "Miami - Vice"
const place = (state: string) => state.split(":").slice(1).join(":").trim();

export async function probe(query: string, protocol: string,
  { timeout, speedTest, stopped = () => false, onStep = () => {}, measure = (fn) => fn() }: ProbeOptions): Promise<Result> {
  const r: Omit<Result, "status"> = { query, protocol, location: "", connectS: null, latencyMs: null, speedMbps: null };
  const end = (status: Status): Result => ({ ...r, status });
  onStep("connecting");
  await windscribe("connect", "-n", query, protocol);
  const t = now();
  try {
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
    await measure(async () => {
      onStep(`measuring latency · ${r.location}`);
      r.latencyMs = await latencyMs();
      if (r.latencyMs !== null && speedTest) {
        onStep(`measuring speed · ${r.location}`);
        r.speedMbps = await speedMbps();
      }
    });
    return end(r.latencyMs === null ? "no internet" : "ok");
  } finally {
    onStep("disconnecting");
    await windscribe("disconnect");
    // the CLI's disconnect can return while the app is still tearing down (it does after a timed-out connect);
    // a connect sent then is swallowed and the next attempt reads as an instant "failed", so wait it out
    for (let i = 0; i < 30 && (await connectState()) === "Disconnecting"; i++) await sleep(1000);
  }
}

/** The attempts that worked, best first: fastest, then lowest latency */
export const sortOk = (results: Result[]) =>
  results.filter((r) => r.status === "ok")
    .sort((x, y) => (y.speedMbps ?? 0) - (x.speedMbps ?? 0) || (x.latencyMs ?? 0) - (y.latencyMs ?? 0));
