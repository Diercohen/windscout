// A scan: every selected datacenter × protocol pair, tried in order, with pause and stop.
import { expandLocations, type Location, type ScanTarget } from "./locations.js";
import { probe, type Result } from "./probe.js";
import { now } from "./time.js";

// ponytail: rough per-attempt cost: a failure burns the timeout, a success ~connect+speed test; refine from real runs
export const attemptSeconds = (timeout: number) => timeout + 5;
export const estimate = (locations: number, protocols: number, timeout: number) => locations * protocols * attemptSeconds(timeout);

export interface ScanOptions {
  timeout: number; // seconds to wait for each connection
  speedTest: boolean; // false = connect-only: skip the download test, rank by latency
  locations?: readonly Location[];
  limit?: number; // maximum distinct datacenters per country; omitted = all
}

/** Called around each attempt, e.g. to print a progress line */
export interface ScanHooks {
  attempt?(country: string, protocol: string, location: string): void;
  result?(r: Result): void;
}

/** Progress views read the fields; their keys call togglePause() and stop() */
export class Scan {
  readonly results: Result[] = [];
  readonly finished: string[] = []; // location queries with every protocol done
  readonly total: number;
  readonly targets: readonly ScanTarget[];
  readonly started = now();
  done = 0;
  attemptStart = now();
  current: { country: string; protocol: string; location: string } | null = null;
  step = ""; // what the running attempt is doing
  stopping = false; // stop after the current attempt
  // a pause lands between attempts, so the VPN is disconnected while waiting
  paused = false;
  waiting = false;
  private waitStart = 0;
  private idle = 0; // seconds spent paused
  private resume = () => {};

  constructor(readonly countries: readonly string[], readonly protocols: readonly string[], readonly options: ScanOptions) {
    this.targets = expandLocations(countries, options.locations, options.limit);
    this.total = this.targets.length * protocols.length;
  }

  /** Seconds spent scanning, pauses not counted */
  elapsed(): number {
    return now() - this.started - this.idle - (this.waiting ? now() - this.waitStart : 0);
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (!this.paused) this.resume();
  }

  stop(): void {
    this.stopping = true;
    this.resume(); // a paused scan stops right away
  }

  async run(hooks: ScanHooks = {}): Promise<Result[]> {
    const { timeout, speedTest } = this.options;
    outer: for (const { country, query, location } of this.targets) {
      for (const protocol of this.protocols) {
        if (this.paused && !this.stopping) {
          this.waiting = true;
          this.waitStart = now();
          await new Promise<void>((resolve) => (this.resume = resolve));
          this.waiting = false;
          this.idle += now() - this.waitStart;
        }
        if (this.stopping) break outer;
        this.current = { country, protocol, location };
        this.attemptStart = now();
        hooks.attempt?.(country, protocol, location);
        const r = await probe(query, protocol, { timeout, speedTest, stopped: () => this.stopping, onStep: (s) => (this.step = s) });
        r.country = country;
        r.location ||= location;
        this.results.push(r);
        this.done++;
        hooks.result?.(r);
        if (r.status === "no such location") { // its other protocols won't connect either
          this.done += this.protocols.length - this.protocols.indexOf(protocol) - 1;
          break;
        }
      }
      this.finished.push(query);
    }
    return this.results;
  }
}
