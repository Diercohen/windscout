// Keeping you connected, for the results screen. It holds the list of working connections, best first. You can connect to one
// (when it doesn't connect: back to the one you had, else the next ones), disconnect, or test them all again, which ranks them
// by what it finds. The watch checks the connection every few seconds, and when it's down, connects again: to the same one or
// the next best. While watching, a checker (background.ts) can try the others now and then without touching this computer's
// VPN. One whose check fails goes to the end of the list, since it may work again later, unless they all fail: that's your
// network, not them, so the list stays as it was. No terminal here: tui/results.ts shows it, and the tests drive it with a
// fake app and clock (KeepIo).
import { setTimeout as wait } from "node:timers/promises";
import { latencyMs } from "./measure.js";
import { attempt, disconnect, probe, target, type Entry, type Result, type Status } from "./probe.js";
import { duration, now } from "./time.js";
import { appLogSize, connectStateOf, place, publicIpOf, toldToDisconnect, vpnIpOf, windscribe } from "./windscribe.js";

export const WATCH_GAP = 3; // seconds between the checks
export const WATCH_MISSES = 3; // checks in a row that find it down (not connected, or no internet through it) before acting
export const WATCH_KEEP = 300; // seconds: one that lasted this long is tried again first when it drops; one that didn't, last
export const WATCH_RETRY = 30; // seconds to wait when none connects, before trying them all again from the best
export const CHECK_EVERY = 300; // seconds between the background checks, while watching
const TRIPS = 20; // round trips kept for the view

// what says a connection doesn't work from here; a container's key limit or missing port, or a stopped attempt, says nothing
const FAILURES: readonly Status[] = ["timeout", "failed", "no internet", "no such location", "no such port", "key limit", "unreliable"];
const CHECK_FAILURES: readonly Status[] = ["timeout", "failed", "no internet", "no such location", "unreliable"];

export type Sort = "speed" | "latency";

/** "Frankfurt - Castle over stealth:443" */
export const label = (r: Result) => `${r.location || r.query} over ${r.protocol}`;

const key = (r: Pick<Result, "query" | "protocol">) => `${r.query} ${r.protocol}`;

/** The working ones first, best first; then the ones whose last check failed, in the order they went there */
export function ranked(entries: readonly Entry[], sort: Sort): Entry[] {
  const latency = (x: Entry, y: Entry) => (x.latencyMs ?? 1e9) - (y.latencyMs ?? 1e9);
  const speed = (x: Entry, y: Entry) => (y.speedMbps ?? -1) - (x.speedMbps ?? -1);
  const by = sort === "speed" ? (x: Entry, y: Entry) => speed(x, y) || latency(x, y) : (x: Entry, y: Entry) => latency(x, y) || speed(x, y);
  return [...entries.filter((e) => !e.failed).sort(by), ...entries.filter((e) => e.failed)];
}

/** What the app said: its connect state as connectStateOf() words it, and the VPN's IP while connected, else this computer's
 * own ("" until the app has checked it) */
export interface AppStatus {
  state: string;
  ip: string;
}

/** What an attempt gets: whether to give up, and where to say what it's doing */
export interface Attempting {
  stopped(): boolean;
  onStep(step: string): void;
}

/** What the keeper asks of the app, the clock and the saved result */
export interface KeepIo {
  status(): Promise<AppStatus>;
  ping(): Promise<number | null>; // a round trip through the tunnel, in ms; null when it didn't get through
  attempt(e: Entry, a: Attempting): Promise<Result>; // connects and checks it as a scan does, and leaves it up when it worked
  probe(e: Entry, speedTest: boolean, a: Attempting): Promise<Result>; // the same, measures (the speed too when asked), disconnects
  disconnect(): Promise<void>;
  logSize(): number; // the app log's size now
  told(size: number): boolean; // whether the app was told to disconnect since its log was size long
  sleep(seconds: number, signal: AbortSignal): Promise<unknown>; // ends early (rejects) when signal aborts
  now(): number; // seconds
  save(entries: Entry[]): void; // the list as it is now, best first: for windscout connect and the scanning types
}

/** The app's side of KeepIo, connecting the way the scan does; save keeps the list */
export const appIo = (timeout: number, save: (entries: Entry[]) => void): KeepIo => ({
  status: async () => {
    const s = await windscribe("status"), state = connectStateOf(s);
    return { state, ip: state.startsWith("Connected") ? vpnIpOf(s) : publicIpOf(s) };
  },
  ping: () => latencyMs(1),
  // nickname: the exact datacenter the list shows, as the connect command in the report does
  attempt: (e, { stopped, onStep }) => attempt(target(e), e.protocol, { timeout, speedTest: false, stopped, onStep }),
  probe: (e, speedTest, { stopped, onStep }) => probe(target(e), e.protocol, { timeout, speedTest, stopped, onStep }),
  disconnect,
  logSize: appLogSize,
  told: toldToDisconnect,
  sleep: (seconds, signal) => wait(seconds * 1000, undefined, { signal }),
  now,
  save,
});

/** Checks connections without touching this computer's VPN: docker containers (background.ts) */
export interface Checker {
  status: string; // what it's doing, or why it can't check, for the view; "" while it's ready
  prepare?(list: Entry[], stopped: () => boolean): Promise<boolean>; // gets ready to check: so trouble shows before the first check
  check(list: Entry[], stopped: () => boolean): Promise<Result[] | null>; // a result per target(e) and protocol; null: it couldn't
  stop(): Promise<void>; // until the next check
}

/** What the keeper is doing: idle (no connection of its own: the app may be connected elsewhere), connecting (you asked),
 * connected, down (no answer through it, and not watching), reconnecting (it dropped, while watching), none (nothing
 * connected; while watching, it tries them all again soon) or testing them all */
export type Phase = "idle" | "connecting" | "connected" | "down" | "reconnecting" | "none" | "testing";

type Command = { kind: "connect"; entry: Entry } | { kind: "disconnect" } | { kind: "test"; speed: boolean };
// what a pass demoted, as it was before: the list's order, and each one's failure
interface Marks {
  order?: Entry[];
  was: Map<Entry, Pick<Entry, "failed" | "failedAt">>;
}
const marks = (): Marks => ({ was: new Map() });

/** Owns the VPN connection while the results screen is open; the view reads the fields and calls the methods */
export class Keeper {
  phase: Phase = "idle";
  current: Entry | null = null; // the one it connected you to, while it's yours
  app: AppStatus = { state: "", ip: "" }; // what the app said at the last check
  since = 0; // when current came up
  ms: number | null = null; // the last round trip through it
  trips: (number | null)[] = []; // the last round trips, oldest first; null: it didn't get through
  misses = 0; // checks in a row that found it down
  drops = 0; // times it connected you again
  lost: { entry: Entry; why: string; lasted: number } | null = null; // the one that dropped, while connecting again
  trying: { entry: Entry; step: string; start: number; n: number; of: number } | null = null; // the attempt running now
  // the test running now; had: the connection it puts back afterwards
  test: { speed: boolean; entry: Entry | null; step: string; start: number; done: number; total: number; had: Entry | null } | null = null;
  retryAt = 0; // none connected: when it tries them all again
  events: { at: Date; text: string }[] = []; // what happened, last ones last
  checker: Checker | null = null; // the background checks, while they run
  checkAt = 0; // when the next background check is due
  lastCheck: { at: number; worked: number; of: number } | null = null; // the last background check's outcome
  changed = false; // the list learned something since the screen opened
  closed = false;
  queued: Command | null = null; // a command waiting for what's running to stop

  private action = new AbortController(); // the running action: a new command, or close(), ends it
  private nap = new AbortController(); // the running wait: anything new ends it early
  private napBackground = new AbortController();
  private backgroundRun = 0; // the background loop that's on: an older one ends
  private backgroundStop: Promise<void> = Promise.resolve(); // the checker stopping
  private cancelled = false; // esc: stops what's running
  private finishing = false; // an attempt that close(true) lets finish
  private finishOnClose = false;
  private dirty = false; // the list changed since it was last saved
  private where = ""; // where the app said it connected to
  private logAt = 0; // the app log's size at the last check that found it up: a disconnect it's told to make lands after it

  constructor(public entries: Entry[], public sort: Sort, public watch: boolean, private readonly io: KeepIo) {}

  ranked(): Entry[] {
    return ranked(this.entries, this.sort);
  }

  connect(entry: Entry): void {
    this.command({ kind: "connect", entry });
  }

  disconnect(): void {
    this.command({ kind: "disconnect" });
  }

  /** Tests them all again, one at a time on this computer, and ranks them by what it finds; then puts the VPN back */
  retest(speed: boolean): void {
    this.command({ kind: "test", speed });
  }

  /** esc: stops a test (the VPN then goes back as it was), or the connecting */
  cancel(): void {
    this.cancelled = true;
    this.nap.abort();
  }

  setWatch(on: boolean): void {
    this.watch = on;
    if (!on && (this.phase === "reconnecting" || this.phase === "none")) this.cancel(); // no connecting again by itself now
    this.nap.abort();
    this.napBackground.abort();
  }

  /** Ends run() and the background checks. finish (quitting): the connection you asked for still gets its attempt, and a test
   * still puts back the connection you had; else (a new scan) everything stops right away */
  close(finish = false): void {
    this.closed = true;
    this.finishOnClose = finish;
    if (!finish) this.action.abort();
    this.nap.abort();
    this.napBackground.abort();
  }

  /** Until close(): runs the commands, one at a time, and checks the connection every WATCH_GAP s in between */
  async run(): Promise<void> {
    if (!this.queued) this.app = await this.io.status();
    while (!this.closed) {
      const c = this.queued;
      this.queued = null;
      this.action = new AbortController();
      this.cancelled = false;
      if (c) await this.act(c, this.action.signal);
      else {
        await this.pause(WATCH_GAP);
        if (!this.queued && !this.closed) await this.check(this.action.signal);
      }
      if (this.dirty) this.save();
    }
  }

  /** While watching: every CHECK_EVERY s (the first in firstIn s) the checker tries the others in the list (not the one you're
   * on: the watch checks that one), and what it finds goes in the list, as a test's does. Until stopBackground() or close() */
  async background(checker: Checker, firstIn = 0): Promise<void> {
    const run = ++this.backgroundRun;
    const on = () => !this.closed && this.backgroundRun === run;
    const stopped = () => !on() || !this.watch;
    const others = () => this.ranked().filter((e) => e !== this.current);
    this.checker = checker;
    this.checkAt = this.io.now() + firstIn;
    if (checker.prepare) await checker.prepare(others(), stopped);
    while (on()) {
      if (this.watch && !this.test && this.io.now() >= this.checkAt) {
        const list = others();
        const results = list.length ? await checker.check(list, stopped) : null;
        if (results && !stopped() && !this.test) this.found(list, results); // a test that started meanwhile finds out itself
        this.checkAt = this.io.now() + CHECK_EVERY;
      }
      this.napBackground = new AbortController();
      await this.io.sleep(this.watch ? Math.max(1, this.checkAt - this.io.now()) : 3600, this.napBackground.signal).catch(() => {});
    }
  }

  /** Ends the background checks; resolves once the checker has stopped what it was doing */
  stopBackground(): Promise<void> {
    const checker = this.checker;
    this.backgroundRun++;
    this.checker = null;
    this.napBackground.abort();
    if (checker) this.backgroundStop = this.backgroundStop.then(() => checker.stop()).catch(() => {});
    return this.backgroundStop;
  }

  private command(c: Command): void {
    this.queued = c;
    this.action.abort();
    this.nap.abort();
  }

  private stopped(signal: AbortSignal): boolean {
    return signal.aborted || this.cancelled || (this.closed && !this.finishing);
  }

  /** An attempt that quitting lets finish: so you end up connected, as you asked */
  private async tryToFinish(e: Entry, signal: AbortSignal, m: Marks): Promise<boolean> {
    this.finishing = true;
    try {
      return await this.tryOne(e, signal, m);
    } finally {
      this.finishing = false;
    }
  }

  private async act(c: Command, signal: AbortSignal): Promise<void> {
    if (c.kind === "disconnect") {
      Object.assign(this, { current: null, lost: null, phase: "idle" });
      await this.io.disconnect();
      this.app = await this.io.status();
      this.event("disconnected");
    } else if (c.kind === "connect") await this.switchTo(c.entry, signal);
    else await this.retestAll(c.speed, signal);
  }

  /** Connects to e. When it doesn't connect: back to the one you had, else the next ones after it, to get you online */
  private async switchTo(e: Entry, signal: AbortSignal): Promise<void> {
    const had = this.phase === "connected" ? this.current : null; // a working connection to go back to
    const list = this.ranked(), at = list.indexOf(e);
    const after = [...list.slice(at + 1), ...list.slice(0, Math.max(0, at))]; // around to the one before it
    const m = marks();
    Object.assign(this, { phase: "connecting", current: null, lost: null });
    await this.io.disconnect(); // one still up would read as this one connecting
    if (await this.tryToFinish(e, signal, m)) return;
    if (this.stopped(signal)) return this.halt();
    if (had && had !== e) {
      if (await this.tryOne(had, signal, m)) return this.event(`${label(e)} didn't connect: back on ${label(had)}`);
      if (this.stopped(signal)) return this.halt();
    }
    const next = after.filter((x) => x !== had);
    if (next.length) this.event(`${label(e)} didn't connect: trying the next ones`);
    await this.tryAll(next, signal, m);
  }

  /** Tries each in turn until one connects. When none does, they all failed, which says more about your network than about
   * them: the list goes back as it was (m). While watching, it then tries them all again from the best every WATCH_RETRY s */
  private async tryAll(order: Entry[], signal: AbortSignal, m: Marks): Promise<boolean> {
    for (;;) {
      for (const [k, e] of order.entries()) {
        if (this.stopped(signal)) return this.halt(), false;
        if (await this.tryOne(e, signal, m, k + 1, order.length)) return true;
      }
      if (this.stopped(signal)) return this.halt(), false;
      this.undo(m);
      this.phase = "none";
      if (!this.watch) {
        this.event(this.entries.length > 1 ? `none of the ${this.entries.length} connects now` : "it doesn't connect now");
        return false;
      }
      this.event(`none of them connects now: trying them all again in ${duration(WATCH_RETRY)}`);
      if (!(await this.waitRetry(signal))) return this.halt(), false;
      order = this.ranked();
    }
  }

  /** WATCH_RETRY s, watching the app: false when it's stopped meanwhile, or you connected in the app yourself */
  private async waitRetry(signal: AbortSignal): Promise<boolean> {
    this.retryAt = this.io.now() + WATCH_RETRY;
    while (this.io.now() < this.retryAt) {
      await this.pause(Math.min(WATCH_GAP, this.retryAt - this.io.now()));
      if (this.stopped(signal)) return false;
      this.app = await this.io.status();
      if (/^Connect(ed|ing)/.test(this.app.state)) {
        this.event("you're connecting in the app: windscout leaves it to you");
        return false;
      }
    }
    return true;
  }

  /** One attempt at e: true once it's up; a failure goes to the end of the list (m keeps what it was) */
  private async tryOne(e: Entry, signal: AbortSignal, m: Marks, n = 1, of = 1): Promise<boolean> {
    this.trying = { entry: e, step: "connecting", start: this.io.now(), n, of };
    const r = await this.io.attempt(e, { stopped: () => this.stopped(signal), onStep: (s) => this.trying && (this.trying.step = s) });
    this.trying = null;
    if (r.status === "ok") {
      this.learn(e, r, false);
      Object.assign(this, { current: e, phase: "connected", lost: null, since: this.io.now(), misses: 0, ms: r.latencyMs,
        trips: [r.latencyMs], where: r.location, logAt: this.io.logSize() });
      this.app = await this.io.status(); // the VPN's IP now, not the one from before
      return true;
    }
    await this.io.disconnect(); // so the next connect isn't swallowed
    if (FAILURES.includes(r.status)) this.demote(e, r.status, m);
    return false;
  }

  /** Stopped while connecting: disconnected, unless it got through */
  private halt(): void {
    this.trying = null;
    if (!this.current) this.phase = "idle";
  }

  /** A check of the connection: still where it connected, with internet through it. When WATCH_MISSES checks in a row find it
   * down, and watching, connects again. When the app was told to disconnect (or restarted), or is connected somewhere else,
   * you're using it yourself: windscout lets it be */
  private async check(signal: AbortSignal): Promise<void> {
    const logAt = this.io.logSize();
    this.app = await this.io.status();
    const { state } = this.app, connected = state.startsWith("Connected"), there = place(state);
    if (!this.current) {
      if (this.phase === "none" && /^Connect(ed|ing)/.test(state)) this.phase = "idle"; // you connected in the app
      return;
    }
    if (connected && there && this.where && there !== this.where) {
      this.event(`you connected to ${there} in the app: windscout leaves it to you`);
      return void Object.assign(this, { current: null, phase: "idle" });
    }
    this.ms = connected ? await this.io.ping() : null;
    this.trips = [...this.trips, this.ms].slice(-TRIPS);
    if (this.ms !== null) {
      Object.assign(this, { misses: 0, logAt, phase: "connected" });
      return;
    }
    // you disconnected (or a script did, or the app was quit): yours to do, not a drop
    if (this.io.told(this.logAt)) {
      this.event("you disconnected in the app: windscout leaves it to you");
      return void Object.assign(this, { current: null, phase: "idle" });
    }
    if (++this.misses < WATCH_MISSES || this.closed) return;
    if (this.watch) await this.failover(connected ? "no internet through it" : state || "not connected", signal);
    else this.phase = "down"; // shows it; the app may still bring it back
  }

  /** It dropped: connects again, to the same one first if it lasted WATCH_KEEP s, else to the next ones first */
  private async failover(why: string, signal: AbortSignal): Promise<void> {
    const dropped = this.current!, lasted = this.io.now() - this.since, m = marks();
    this.event(`✗ ${label(dropped)}: ${why} · it lasted ${duration(lasted)}`);
    Object.assign(this, { lost: { entry: dropped, why, lasted }, phase: "reconnecting", current: null });
    await this.io.disconnect();
    // a hiccup in one that lasted: the same again; one that dropped soon is likely blocked, so it goes to the end
    if (lasted < WATCH_KEEP) this.demote(dropped, `dropped after ${duration(lasted)}`, m);
    const order = lasted >= WATCH_KEEP ? [dropped, ...this.ranked().filter((e) => e !== dropped)] : this.ranked();
    if (await this.tryAll(order, signal, m)) {
      this.drops++;
      this.event(`✓ connected again: ${label(this.current!)}`);
    }
  }

  /** Each in the list, in its order, on this computer: connects, measures, disconnects. Then ranks them by what it found,
   * the failed ones last, and connects you again: to the one you had if it still works, else the best */
  private async retestAll(speed: boolean, signal: AbortSignal): Promise<void> {
    const had = this.phase === "connected" || this.phase === "down" ? this.current : null;
    const list = this.ranked(), m = marks();
    let what = speed ? "speed test" : "latency test";
    Object.assign(this, { phase: "testing", current: null, lost: null });
    const test = this.test = { speed, entry: null as Entry | null, step: "", start: this.io.now(), done: 0, total: list.length, had };
    await this.io.disconnect();
    let worked = 0, failed = 0;
    for (const e of list) {
      if (this.stopped(signal)) break;
      Object.assign(test, { entry: e, step: "connecting" });
      const r = await this.io.probe(e, speed, { stopped: () => this.stopped(signal), onStep: (s) => (test.step = s) });
      if (r.status === "interrupted") break;
      if (r.status === "ok") worked++, this.learn(e, r, speed);
      else if (FAILURES.includes(r.status)) failed++, this.demote(e, r.status, m);
      test.done++;
    }
    Object.assign(this, { test: null, phase: "idle" });
    if (test.done < list.length) what += ` (stopped after ${test.done} of ${list.length})`;
    if (!worked && failed > 1) {
      this.undo(m);
      this.event(`${what}: none of them connected · is your network down? The list stays as it was`);
    } else if (worked + failed) {
      this.event(`${what}: ${worked} of ${worked + failed} work${failed ? ` · ${failed === 1 ? "the one that didn't" : `the ${failed} that didn't`} went to the end` : ""}`);
    }
    if (signal.aborted || !had) return; // another command takes over, or there's nothing to go back to
    this.phase = "connecting";
    if (this.closed) { // quitting: back on the one you had (else the best), one attempt
      const back = had.failed ? this.ranked().find((e) => !e.failed) : had;
      if (!this.finishOnClose || !back) return this.halt();
      this.cancelled = false;
      return void (await this.tryToFinish(back, signal, marks()), this.halt());
    }
    this.cancelled = false; // esc stopped the test: the VPN still goes back
    await this.tryAll(had.failed ? this.ranked() : [had, ...this.ranked().filter((e) => e !== had)], signal, marks());
  }

  /** What the checker found: the ones that worked get its latency, the others go to the end, unless none worked. The one
   * you're on gets the best of the watch's last round trips, as a scan measures the best of a few */
  private found(list: Entry[], results: Result[]): void {
    const by = new Map(results.map((r) => [key(r), r])), m = marks();
    let worked = 0, failed = 0;
    for (const e of list) {
      const r = by.get(`${target(e)} ${e.protocol}`);
      if (!r || e === this.current) continue;
      if (r.status === "ok") worked++, this.learn(e, r, false);
      else if (CHECK_FAILURES.includes(r.status)) failed++, this.demote(e, r.status, m);
    }
    if (!worked && failed > 1) this.undo(m); // the containers couldn't get anywhere: that's no news about the list
    const trips = this.trips.filter((t): t is number => t !== null);
    if (this.current && this.phase === "connected" && trips.length) this.learn(this.current, { ...this.current, latencyMs: Math.min(...trips) }, false);
    this.lastCheck = { at: Date.now(), worked, of: worked + failed };
    if (this.dirty) this.save();
  }

  /** It worked: what it measured (the speed only from a speed test) */
  private learn(e: Entry, r: Result, speed: boolean): void {
    Object.assign(e, { location: r.location || e.location, connectS: r.connectS ?? e.connectS, latencyMs: r.latencyMs ?? e.latencyMs, checked: Date.now() });
    if (speed) e.speedMbps = r.speedMbps;
    delete e.failed;
    delete e.failedAt;
    this.changed = this.dirty = true;
  }

  /** It didn't get through: to the end of the list, since it may work again later */
  private demote(e: Entry, why: string, m: Marks): void {
    m.order ??= [...this.entries];
    if (!m.was.has(e)) m.was.set(e, { failed: e.failed, failedAt: e.failedAt });
    Object.assign(e, { failed: why, failedAt: Date.now() });
    this.entries = [...this.entries.filter((x) => x !== e), e];
    this.changed = this.dirty = true;
  }

  /** Back as they were before a pass where everything failed */
  private undo(m: Marks): void {
    for (const [e, was] of m.was) {
      if (was.failed) Object.assign(e, was);
      else delete e.failed, delete e.failedAt;
    }
    if (m.order) this.entries = m.order;
  }

  private save(): void {
    this.dirty = false;
    this.io.save(this.ranked());
  }

  private event(text: string): void {
    this.events = [...this.events, { at: new Date(), text }].slice(-20);
  }

  private async pause(seconds: number): Promise<void> {
    this.nap = new AbortController();
    await this.io.sleep(seconds, this.nap.signal).catch(() => {}); // aborted: something new to do
  }
}
