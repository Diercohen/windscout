// Keeping a connection up once it's made: a check every few seconds, and when it's down, connecting again, to the same one or
// the next. No terminal here: tui/connect.ts shows it, and the tests drive it with a fake app (WatchIo).
import { setTimeout as wait } from "node:timers/promises";
import { latencyMs } from "./measure.js";
import { disconnect, type Result } from "./probe.js";
import { now } from "./time.js";
import { appLogSize, connectState, place, toldToDisconnect } from "./windscribe.js";

export const WATCH_GAP = 3; // seconds between the checks
export const WATCH_MISSES = 3; // checks in a row that find it down (not connected, or no internet through it) before acting
export const WATCH_KEEP = 300; // seconds: one that lasted this long is tried again first when it drops; one that didn't, last
export const WATCH_RETRY = 30; // seconds to wait when none connects, before trying them all again from the best

/** What the watch asks of the app and the clock */
export interface WatchIo {
  state(): Promise<string>; // the app's connect state: "Connected: Frankfurt - Castle", "Connecting: …", "Disconnected"
  ping(): Promise<number | null>; // a round trip through the tunnel, in ms; null when it didn't get through
  connect(from: number): Promise<number>; // connects to list[from], or the next ones in turn: the index that did, or -1
  disconnect(): Promise<void>;
  logSize(): number; // the app log's size now
  told(size: number): boolean; // whether the app was told to disconnect since its log was size long
  sleep(seconds: number, signal: AbortSignal): Promise<unknown>; // ends early (rejects) when signal aborts
  now(): number; // seconds
}

/** The app's side of WatchIo, all but connect: that one prints, so the view makes it */
export const appIo: Omit<WatchIo, "connect"> = {
  state: connectState,
  ping: () => latencyMs(1),
  disconnect,
  logSize: appLogSize,
  told: toldToDisconnect,
  sleep: (seconds, signal) => wait(seconds * 1000, undefined, { signal }),
  now,
};

/** What happens, for the view */
export interface WatchHooks {
  dropped?(why: string, lasted: number): void; // it's down: connecting again
  none?(): void; // none of them connected: trying them all again after WATCH_RETRY s
}

/** Watches list[i] once it's up; the view reads the fields and calls stop() */
export class Watch {
  since: number; // when the connection came up
  misses = 0; // checks in a row that found it down
  ms: number | null = null; // the last check's round trip
  drops = 0; // times it connected again
  stopped = false;
  why = ""; // why the watch stopped by itself: someone else is using the app
  private where = ""; // where the app said it connected to
  private logAt = 0; // the app log's size at the last check that found it up: a disconnect it's told to make lands after it
  private wake = () => {};

  constructor(readonly list: readonly Result[], public i: number, private readonly io: WatchIo, private readonly on: WatchHooks = {}) {
    this.since = io.now();
  }

  stop(why = ""): void {
    this.stopped = true;
    this.why ||= why;
    this.wake();
  }

  /** Until stop(): checks every WATCH_GAP s that the app is connected where it was, with internet through it. When WATCH_MISSES
   * checks in a row find it down, connects again: the same one first if it lasted WATCH_KEEP s, else the next ones first; when
   * none connects, tries them all again from the best after WATCH_RETRY s. When the app was told to disconnect (or restarted),
   * or is connected somewhere else, you're using it yourself: the watch stops */
  async run(): Promise<void> {
    await this.up();
    while (!this.stopped) {
      await this.pause(WATCH_GAP);
      if (this.stopped) break;
      const logAt = this.io.logSize(), state = await this.io.state(), connected = state.startsWith("Connected");
      const there = place(state);
      if (connected && there && this.where && there !== this.where) return this.stop(`the app is connected to ${there} now`);
      this.ms = connected ? await this.io.ping() : null;
      if (this.ms !== null) {
        this.misses = 0;
        this.logAt = logAt;
        continue;
      }
      // you disconnected (or a script did, or the app was quit): yours to do, not a drop
      if (this.io.told(this.logAt)) return this.stop("the app was told to disconnect, or restarted");
      if (++this.misses < WATCH_MISSES || this.stopped) continue;
      const lasted = this.io.now() - this.since;
      this.on.dropped?.(connected ? "no internet through it" : state || "not connected", lasted);
      await this.io.disconnect();
      // a hiccup in one that lasted: the same again; one that dropped soon is likely blocked, so it goes after the others
      let from = lasted >= WATCH_KEEP ? this.i : (this.i + 1) % this.list.length;
      for (;;) {
        const j = await this.io.connect(from);
        if (j >= 0) {
          this.i = j;
          break;
        }
        if (this.stopped) return;
        this.on.none?.();
        await this.pause(WATCH_RETRY);
        if (this.stopped) return;
        from = 0;
      }
      this.drops++;
      await this.up();
    }
  }

  /** A connection just came up: since when, where the app says it is, and the log so far, which has the watch's own disconnects
   * and connects in it, logged as if you'd made them */
  private async up(): Promise<void> {
    this.since = this.io.now();
    this.misses = 0;
    this.ms = null;
    this.logAt = this.io.logSize();
    this.where = place(await this.io.state());
  }

  private async pause(seconds: number): Promise<void> {
    const ac = new AbortController();
    this.wake = () => ac.abort();
    await this.io.sleep(seconds, ac.signal).catch(() => {}); // aborted: stop()
  }
}
