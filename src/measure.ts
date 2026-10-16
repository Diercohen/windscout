// Latency and download speed over whatever connection is up (the VPN tunnel, during a scan).
import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
import { now } from "./time.js";

// a slow tunnel can take over a second to open a TCP connection, but Node's happy eyeballs gives each address 250 ms,
// fails fast on IPv6 (no route on Linux), and fetch ends in ETIMEDOUT though the VPN works.
// Connect to one IPv4 address instead, with the whole timeout
setDefaultAutoSelectFamily(false);
setDefaultResultOrder("ipv4first");

const LATENCY_URL = "https://www.gstatic.com/generate_204";
const SPEED_URL = "https://speed.cloudflare.com/__down?bytes=10000000";
const SPEED_SECONDS = 15;

/** Best round trip of a few tries, in ms; null if none got through */
export async function latencyMs(tries = 3): Promise<number | null> {
  let best: number | null = null;
  for (let i = 0; i < tries; i++) {
    const t = now();
    try {
      await (await fetch(LATENCY_URL, { signal: AbortSignal.timeout(5000) })).arrayBuffer();
    } catch {
      continue;
    }
    const ms = (now() - t) * 1000;
    best = best === null ? ms : Math.min(best, ms);
  }
  return best;
}

/** Download speed in Mbps over at most SPEED_SECONDS; null if nothing arrived */
export async function speedMbps(): Promise<number | null> {
  const t = now();
  let n = 0;
  try {
    const res = await fetch(SPEED_URL, {
      headers: { "User-Agent": "curl/8" }, // Cloudflare 403s unknown clients
      signal: AbortSignal.timeout(SPEED_SECONDS * 1000),
    });
    if (!res.ok || !res.body) return null;
    for await (const chunk of res.body) n += chunk.length;
  } catch {
    if (!n) return null; // timeout mid-download is fine: we measured what arrived
  }
  return (n * 8) / (now() - t) / 1e6;
}
