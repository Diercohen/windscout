// A scan: every country × protocol pair, tried in order, with pause and stop.
// Each slot runs one attempt at a time: one slot here, or one per docker container in a parallel scan.
import { probe, type ProbeOptions, type Result } from "./probe.js";
import { now } from "./time.js";

// ponytail: rough per-attempt cost: a failure burns the timeout, a success ~connect+speed test; refine from real runs
export const attemptSeconds = (timeout: number) => timeout + 5;
export const estimate = (attempts: number, timeout: number, slots = 1) => Math.ceil(attempts / slots) * attemptSeconds(timeout);

/** Runs one attempt: probe() here, or in a docker container (docker.ts). Throws when it can't run any more */
export type Prober = (query: string, protocol: string, options: ProbeOptions) => Promise<Result>;

export interface ScanOptions {
  timeout: number; // seconds to wait for each connection
  speedTest: boolean; // false = connect-only: skip the download test, rank by latency
}

/** Called around each attempt, e.g. to print a progress line */
export interface ScanHooks {
  attempt?(country: string, protocol: string): void;
  result?(r: Result): void;
}

/** Attempts the slots can't make (protocols): they run through prober once the slots are done, one at a time */
export interface After {
  prober: Prober;
  protocols: ReadonlySet<string>;
  name: string; // for its slot in the views
}

/** What a slot is doing, for the views */
export interface Slot {
  current: { country: string; protocol: string } | null;
  step: string; // what the running attempt is doing; once current stays null, why the slot stopped
  attemptStart: number;
  name?: string; // the after-slot's
}

type Attempt = { country: string; protocol: string };

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
  // a pause lands between attempts, so the VPN is disconnected while waiting
  paused = false;
  waiting = false; // paused, and no attempt running
  private waitStart = 0;
  private idle = 0; // seconds spent paused
  private resume = () => {};
  private unpaused = Promise.resolve();

  constructor(readonly countries: readonly string[], readonly protocols: readonly string[], readonly options: ScanOptions,
    private readonly probers: Prober[] = [probe], private readonly after?: After) {
    this.total = countries.length * protocols.length;
    this.slots = probers.map(() => ({ current: null, step: "", attemptStart: now() }));
    if (after) this.slots.push({ current: null, step: "", attemptStart: now(), name: after.name });
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

  async run(hooks: ScanHooks = {}): Promise<Result[]> {
    const queue = this.countries.flatMap((country) => this.protocols.map((protocol) => ({ country, protocol })));
    const left = new Map(this.countries.map((c) => [c, this.protocols.length])); // attempts to go, per country
    const later = this.after?.protocols ?? new Set();
    await Promise.all(this.probers.map((prober, i) => this.work(prober, this.slots[i], (p) => !later.has(p), queue, left, hooks)));
    // then the rest, also what slots whose container stopped left over
    if (this.after) await this.work(this.after.prober, this.slots[this.probers.length], () => true, queue, left, hooks);
    return this.results;
  }

  /** One slot: takes the attempts it can make from the queue, one at a time, until there are none */
  private async work(prober: Prober, slot: Slot, can: (protocol: string) => boolean, queue: Attempt[], left: Map<string, number>, hooks: ScanHooks) {
    const { timeout, speedTest } = this.options;
    for (;;) {
      while (this.paused && !this.stopping) {
        if (!this.waiting && this.slots.every((s) => !s.current)) { // the last running attempt is over
          this.waiting = true;
          this.waitStart = now();
        }
        await this.unpaused;
      }
      const i = this.stopping ? -1 : queue.findIndex((a) => can(a.protocol));
      if (i < 0) return;
      const [next] = queue.splice(i, 1);
      const { country, protocol } = next;
      Object.assign(slot, { current: next, step: "", attemptStart: now() });
      hooks.attempt?.(country, protocol);
      let r: Result;
      try {
        r = await prober(country, protocol, { timeout, speedTest, stopped: () => this.stopping, onStep: (s) => (slot.step = s) });
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
    }
  }
}
