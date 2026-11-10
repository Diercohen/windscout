// A scan: the attempts its scanning type plans (plan()), tried in order, with pause and stop.
// Each slot runs one attempt at a time: one slot here, or one per docker container in a parallel scan.
import { probe, reliable, type ProbeOptions, type Result } from "./probe.js";
import { now } from "./time.js";

// ponytail: rough per-attempt cost: a failure burns the timeout, a success ~connect+speed test; refine from real runs
export const attemptSeconds = (timeout: number) => timeout + 5;
export const estimate = (attempts: number, timeout: number, slots = 1) => Math.ceil(attempts / slots) * attemptSeconds(timeout);

/** Runs one attempt: probe() here, or in a docker container (docker.ts). Throws when it can't run any more */
export type Prober = (query: string, protocol: string, options: ProbeOptions) => Promise<Result>;

export interface ScanOptions {
  timeout: number; // seconds to wait for each connection
  speedTest: boolean; // false = connect-only: skip the download test, rank by latency
  only?: readonly Attempt[]; // just these pairs, in this order (plan()), not every country × protocol in list order
  stopAtFirst?: boolean; // check each connection holds up (probe's steady), and stop at the first reliable one: no more start
}

/** Called around each attempt, e.g. to print a progress line */
export interface ScanHooks {
  attempt?(country: string, protocol: string): void;
  result?(r: Result): void;
}

/** What a slot is doing, for the views */
export interface Slot {
  current: { country: string; protocol: string } | null;
  step: string; // what the running attempt is doing; once current stays null, why the slot stopped
  attemptStart: number;
}

export type Attempt = { country: string; protocol: string; saved?: boolean }; // saved: a working connection of the last result

/** The scanning type: the selection in list order, or with its countries shuffled; the last result's working connections that
 * are in the selection first, then the rest of it; or only the last result's working connections, whatever is selected */
export type Order = "default" | "random" | "last-first" | "last-only";
export const ORDERS: readonly Order[] = ["default", "random", "last-first", "last-only"];

const base = (protocol: string) => protocol.split(":")[0]; // "tcp:443" → "tcp"

/** What a scan of these countries and protocols tries, in the order of the scanning type, each once. saved: the last result's
 * connections, best first. ports: each protocol's ports, its default first, so "tcp" and "tcp:443" are one attempt */
export function plan(order: Order, countries: readonly string[], protocols: readonly string[],
  saved: readonly Pick<Result, "query" | "protocol">[] = [], ports: ReadonlyMap<string, number[]> = new Map()): Attempt[] {
  const seen = new Set<string>();
  const once = ({ country, protocol }: Attempt) => {
    const [p, port] = protocol.split(":"), key = `${country} ${p}:${port ?? ports.get(p)?.[0] ?? ""}`;
    return !seen.has(key) && !!seen.add(key);
  };
  const last = saved.map((r): Attempt => ({ country: r.query, protocol: r.protocol, saved: true }));
  if (order === "last-only") return last.filter(once);
  const bases = new Set(protocols.map(base));
  const first = order === "last-first" ? last.filter((a) => countries.includes(a.country) && bases.has(base(a.protocol))) : [];
  const list = order === "random" ? countries.map((c) => [Math.random(), c] as const).sort(([x], [y]) => x - y).map(([, c]) => c) : countries;
  return [...first, ...list.flatMap((country) => protocols.map((protocol) => ({ country, protocol })))].filter(once);
}

/** Progress views read the fields; their keys call togglePause() and stop() */
export class Scan {
  readonly results: Result[] = [];
  readonly finished: string[] = []; // countries with every attempt done: the views refresh their tables per country
  readonly errors: string[] = []; // why slots stopped early
  readonly slots: Slot[];
  readonly total: number;
  readonly started = now();
  done = 0;
  stopping = false; // stop after the current attempts
  found = false; // stopAtFirst: a connection held up, so the scan is stopping
  // a pause lands between attempts, so the VPN is disconnected while waiting
  paused = false;
  waiting = false; // paused, and no attempt running
  private waitStart = 0;
  private idle = 0; // seconds spent paused
  private resume = () => {};
  private unpaused = Promise.resolve();

  constructor(readonly countries: readonly string[], readonly protocols: readonly string[], readonly options: ScanOptions,
    private readonly probers: Prober[] = [probe]) {
    this.total = this.attempts().length;
    this.slots = probers.map(() => ({ current: null, step: "", attemptStart: now() }));
  }

  /** Seconds spent scanning, pauses not counted */
  elapsed(): number {
    return now() - this.started - this.idle - (this.waiting ? now() - this.waitStart : 0);
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) this.unpaused = new Promise((resolve) => (this.resume = resolve));
    else this.wake();
  }

  stop(): void {
    this.stopping = true;
    this.wake(); // a paused scan stops right away
  }

  private wake(): void {
    if (this.waiting) this.idle += now() - this.waitStart;
    this.waiting = false;
    this.resume();
  }

  private attempts(): Attempt[] {
    return this.options.only?.map((a) => ({ ...a }))
      ?? this.countries.flatMap((country) => this.protocols.map((protocol) => ({ country, protocol })));
  }

  async run(hooks: ScanHooks = {}): Promise<Result[]> {
    const queue = this.attempts();
    const left = new Map<string, number>(); // attempts to go, per country
    for (const { country } of queue) left.set(country, (left.get(country) ?? 0) + 1);
    // when every slot's container stops, what they left isn't tried: scan.errors says why
    await Promise.all(this.probers.map((prober, i) => this.work(prober, this.slots[i], queue, left, hooks)));
    return this.results;
  }

  /** One slot: takes the attempts from the queue, one at a time, until there are none */
  private async work(prober: Prober, slot: Slot, queue: Attempt[], left: Map<string, number>, hooks: ScanHooks) {
    const { timeout, speedTest, stopAtFirst = false } = this.options;
    for (;;) {
      while (this.paused && !this.stopping) {
        if (!this.waiting && this.slots.every((s) => !s.current)) { // the last running attempt is over
          this.waiting = true;
          this.waitStart = now();
        }
        await this.unpaused;
      }
      const next = this.stopping ? undefined : queue.shift();
      if (!next) return;
      const { country, protocol } = next;
      Object.assign(slot, { current: next, step: "", attemptStart: now() });
      hooks.attempt?.(country, protocol);
      let r: Result;
      try {
        r = await prober(country, protocol, { timeout, speedTest, steady: stopAtFirst, stopped: () => this.stopping, onStep: (s) => (slot.step = s) });
      } catch (e) { // this slot is done for (its container stopped): the others take over its attempt
        queue.unshift(next);
        Object.assign(slot, { current: null, step: (e as Error).message });
        this.errors.push((e as Error).message);
        return;
      }
      Object.assign(slot, { current: null, step: "" });
      this.results.push(r);
      let n = 1;
      if (r.status === "no such location") // its other protocols won't connect either
        for (let j = queue.length - 1; j >= 0; j--) if (queue[j].country === country) queue.splice(j, 1), n++;
      this.done += n;
      left.set(country, left.get(country)! - n);
      if (!left.get(country)) this.finished.push(country);
      hooks.result?.(r);
      if (stopAtFirst && reliable(r) && !this.stopping) {
        this.found = true;
        this.stop();
      }
    }
  }
}
