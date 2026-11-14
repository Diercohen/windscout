// The results screen's keeper, with a fake app and clock (no VPN), against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_EVERY, Keeper, ranked, WATCH_GAP, WATCH_KEEP, WATCH_MISSES, WATCH_RETRY } from "../dist/watch.js";

const TOLD = "ConnectionManager::clickDisconnect()\n";
const entry = (q, latencyMs, speedMbps = null) =>
  ({ query: q, protocol: "wireguard", location: `${q}ville - ${q}`, connectS: 1, latencyMs, speedMbps, status: "ok" });
const key = (e) => e.query;

// A fake app. The clock moves only when the keeper sleeps or an attempt waits; then at(t, app, k) can change things. Like the
// real one, the app logs each disconnect it's told to make, the keeper's own too. app.fails: what an attempt at that query
// gives instead of connecting ("timeout", …); app.measure: what a test measures there
function fakeApp(at = () => {}) {
  const app = {
    t: 0, on: null, internet: true, elsewhere: "", log: "", fails: {}, measure: {},
    tried: [], // [query, t] of each attempt to connect
    tested: [], // queries a test measured
    saved: null, // the list as last saved, queries best first
    k: null,
    tick(seconds) {
      app.t += seconds;
      at(app.t, app, app.k);
    },
    status: async () => ({ state: app.on ? `Connected: ${app.elsewhere || app.on.location}` : "Disconnected", ip: app.on ? "10.0.0.1" : "1.2.3.4" }),
    ping: async () => (app.on && app.internet ? 40 : null),
    attempt: async (e, { stopped }) => {
      app.tried.push([key(e), app.t]);
      app.tick(5); // connecting takes a moment
      if (stopped()) return { ...e, status: "interrupted" };
      if (app.fails[key(e)]) return { ...e, status: app.fails[key(e)] };
      app.on = e;
      app.internet = true;
      return { ...e, status: "ok" };
    },
    probe: async (e, speed, { stopped }) => {
      app.tick(5);
      if (stopped()) return { ...e, status: "interrupted" };
      app.tested.push(key(e));
      app.on = null; // a test disconnects after each
      if (app.fails[key(e)]) return { ...e, status: app.fails[key(e)] };
      return { ...e, ...app.measure[key(e)], status: "ok" };
    },
    disconnect: async () => {
      app.on = null;
      app.log += TOLD;
    },
    logSize: () => app.log.length,
    told: (size) => app.log.slice(size).includes(TOLD),
    sleep: async (seconds, signal) => {
      if (signal.aborted) throw new Error("aborted");
      app.tick(seconds);
    },
    now: () => app.t,
    save: (list) => (app.saved = list.map(key)),
  };
  return app;
}

const keeper = (app, list, { sort = "latency", watch = true } = {}) => (app.k = new Keeper(list, sort, watch, app));
const queries = (k) => k.ranked().map(key);

test("ranked: the working ones best first, by speed or latency, then the failed ones in the order they failed", () => {
  const [a, b, c, d] = [entry("A", 50, 20), entry("B", 30, 10), { ...entry("C", 10, 90), failed: "timeout" }, entry("D", 40, 30)];
  assert.deepEqual(ranked([a, b, c, d], "speed").map(key), ["D", "A", "B", "C"]);
  assert.deepEqual(ranked([a, b, c, d], "latency").map(key), ["B", "D", "A", "C"]);
});

test("connecting to one: it's yours, the list is saved, and quitting leaves it connected", async () => {
  const list = [entry("A", 40), entry("B", 50)];
  const app = fakeApp((t, app, k) => t >= 30 && k.close(true));
  const k = keeper(app, list);
  k.connect(list[1]);
  await k.run();
  assert.equal(k.current, list[1]);
  assert.equal(k.phase, "connected");
  assert.equal(app.on, list[1]);
  assert.deepEqual(app.saved, ["A", "B"]);
  assert.equal(typeof list[1].checked, "number");
});

test(`a blip isn't a drop; ${WATCH_MISSES} checks in a row are, and one that dropped soon goes to the end`, async () => {
  const list = [entry("A", 40), entry("B", 50), entry("C", 60)];
  let dropAt = 0;
  const app = fakeApp((t, app, k) => {
    if (t === 32) app.internet = false; // the next check misses, the one after gets through
    if (t === 38) app.internet = true;
    if (t === 62) app.on = null, dropAt = t + (WATCH_MISSES - 1) * WATCH_GAP; // dropped by itself: nothing told it to
    if (t >= 200) k.close(true);
  });
  const k = keeper(app, list);
  k.connect(list[0]);
  await k.run();
  assert.deepEqual(app.tried, [["A", 0], ["B", dropAt]]);
  assert.equal(k.current, list[1]);
  assert.equal(k.drops, 1);
  assert.match(list[0].failed, /^dropped after/);
  assert.deepEqual(queries(k), ["B", "C", "A"]);
  assert.deepEqual(app.saved, ["B", "C", "A"]);
});

test("one that lasted is tried again first; when none connects, the list stays and they're all tried again from the best", async () => {
  const list = [entry("A", 40), entry("B", 50)];
  const app = fakeApp((t, app, k) => {
    if (t === WATCH_KEEP + 2) app.internet = false, app.fails = { A: "timeout", B: "timeout" }; // no internet through it now
    if (app.tried.length === 4) app.fails = {}; // after the wait, A works again
    if (t > WATCH_KEEP + 200) k.close(true);
  });
  const k = keeper(app, list);
  k.connect(list[0]);
  await k.run();
  const tried = app.tried.map(([q]) => q);
  assert.deepEqual(tried, ["A", "A", "B", "A"]); // A first, then A again (it lasted), B; then from the best after the wait
  const [, , second, again] = app.tried.map(([, t]) => t);
  assert.ok(again - second >= WATCH_RETRY);
  assert.equal(k.current, list[0]);
  assert.equal(list[0].failed, undefined); // none connected: that's the network, so nothing was demoted
  assert.equal(list[1].failed, undefined);
});

test("disconnecting in the app, or connecting it elsewhere, is yours: windscout leaves the app alone", async () => {
  for (const [change, event] of [
    [(app) => ((app.on = null), (app.log += TOLD)), /you disconnected in the app/],
    [(app) => (app.elsewhere = "Otherville - O"), /you connected to Otherville - O in the app/],
  ]) {
    const list = [entry("A", 40), entry("B", 50)];
    const app = fakeApp((t, app, k) => {
      if (t === 32) change(app);
      if (t > 300) k.close(true);
    });
    const k = keeper(app, list);
    k.connect(list[0]);
    await k.run();
    assert.equal(k.current, null);
    assert.equal(k.phase, "idle");
    assert.deepEqual(app.tried.map(([q]) => q), ["A"]);
    assert.match(k.events.at(-1).text, event);
  }
});

test("with the watch off, a drop shows, and nothing connects again by itself", async () => {
  const list = [entry("A", 40), entry("B", 50)];
  const app = fakeApp((t, app, k) => {
    if (t === 32) app.internet = false;
    if (t > 100) k.close(true);
  });
  const k = keeper(app, list, { watch: false });
  k.connect(list[0]);
  await k.run();
  assert.equal(k.phase, "down");
  assert.deepEqual(app.tried.map(([q]) => q), ["A"]);
});

test("switching to one that doesn't connect goes back to the one you had, and that one goes to the end", async () => {
  const list = [entry("A", 40), entry("B", 50), entry("C", 60)];
  const app = fakeApp((t, app, k) => {
    if (t === 20) app.fails = { C: "timeout" }, k.connect(list[2]);
    if (t > 100) k.close(true);
  });
  const k = keeper(app, list);
  k.connect(list[1]);
  await k.run();
  assert.deepEqual(app.tried.map(([q]) => q), ["B", "C", "B"]);
  assert.equal(k.current, list[1]);
  assert.equal(list[2].failed, "timeout");
  assert.match(k.events.at(-1).text, /didn't connect: back on Bville - B/);
});

test("testing them all again ranks them by what it finds, puts the failed ones last, and connects you back", async () => {
  const list = [entry("A", 40, 10), entry("B", 50, 20), entry("C", 60, 30)];
  const app = fakeApp((t, app, k) => {
    if (t === 20) k.retest(true);
    if (t > 200) k.close(true);
  });
  app.measure = { A: { latencyMs: 45, speedMbps: 50 }, C: { latencyMs: 70, speedMbps: 5 } };
  app.fails = { B: "no internet" };
  const k = keeper(app, list, { sort: "speed" });
  k.connect(list[0]);
  await k.run();
  assert.deepEqual(app.tested, ["C", "B", "A"]); // in the list's order: by speed, C was best
  assert.deepEqual(queries(k), ["A", "C", "B"]);
  assert.equal(list[1].failed, "no internet");
  assert.equal(list[0].speedMbps, 50);
  assert.equal(k.current, list[0]); // the one it had still works
  assert.deepEqual(app.saved, ["A", "C", "B"]);
  assert.match(k.events.find((e) => e.text.startsWith("speed test")).text, /2 of 3 work · the one that didn't went to the end/);
});

test("a test where none connects is your network: the list stays as it was", async () => {
  const list = [entry("A", 40), entry("B", 50), entry("C", 60)];
  const app = fakeApp((t, app, k) => {
    if (t === 20) app.fails = { A: "timeout", B: "timeout", C: "timeout" }, k.retest(false);
    if (t > 100) k.close(true);
  });
  list[2].failed = "timeout"; // C had failed before: it stays failed, where it was
  const k = keeper(app, list);
  k.entries = [list[2], list[0], list[1]];
  k.connect(list[0]);
  await k.run();
  assert.deepEqual(k.entries.map(key), ["C", "A", "B"]);
  assert.deepEqual([list[0].failed, list[1].failed, list[2].failed], [undefined, undefined, "timeout"]);
  assert.match(k.events.find((e) => e.text.startsWith("latency test")).text, /is your network down/);
});

test("quitting lets the connection you asked for finish, and a test put back the one you had", async () => {
  const list = [entry("A", 40), entry("B", 50)];
  let app = fakeApp((t, app, k) => {
    if (t === 5) k.close(true); // while connecting: an attempt takes 5 s here
  });
  let k = keeper(app, list);
  k.connect(list[1]);
  await k.run();
  assert.equal(k.current, list[1]);
  assert.equal(app.on, list[1]);

  app = fakeApp((t, app, k) => {
    if (t === 20) k.retest(false);
    if (app.tested.length === 1) k.close(true); // while testing
  });
  k = keeper(app, list);
  k.connect(list[0]);
  await k.run();
  assert.deepEqual(app.tested, ["A"]);
  assert.equal(k.current, list[0]);
  assert.equal(app.on, list[0]);
});

test("a new scan stops everything right away", async () => {
  const list = [entry("A", 40), entry("B", 50)];
  const app = fakeApp((t, app, k) => {
    if (t === 5) k.close(false);
  });
  const k = keeper(app, list);
  k.connect(list[1]);
  await k.run();
  assert.equal(k.current, null);
  assert.equal(app.on, null);
});

test("close() ends it while it waits", async () => {
  const app = fakeApp();
  app.sleep = (_, signal) => new Promise((_, reject) => signal.addEventListener("abort", reject));
  const k = keeper(app, [entry("A", 40)]);
  const run = k.run();
  setTimeout(() => k.close(true), 10);
  await run;
  assert.equal(k.closed, true);
});

test("background checks: what works gets the containers' latency, what doesn't goes last, the one you're on keeps the watch's", async () => {
  const list = [entry("A", 40), entry("B", 50), entry("C", 60)];
  const app = fakeApp((t, app, k) => t >= CHECK_EVERY && k.close(true));
  const k = keeper(app, list);
  Object.assign(k, { current: list[0], phase: "connected", trips: [55, 45, null, 60] });
  const checked = [];
  const checker = {
    status: "",
    check: async (l) => (checked.push(l.map(key)), [{ ...list[1], query: "B", latencyMs: 20 }, { ...list[2], query: "C", status: "timeout" }]),
    stop: async () => {},
  };
  await k.background(checker);
  assert.deepEqual(checked, [["B", "C"]]); // not the one you're on
  assert.deepEqual(queries(k), ["B", "A", "C"]);
  assert.equal(list[0].latencyMs, 45);
  assert.equal(list[2].failed, "timeout");
  assert.deepEqual(k.lastCheck && [k.lastCheck.worked, k.lastCheck.of], [1, 2]);
  assert.deepEqual(app.saved, ["B", "A", "C"]);
});

test("background checks where nothing worked say nothing about the list", async () => {
  const list = [entry("A", 40), entry("B", 50), entry("C", 60)];
  const app = fakeApp((t, app, k) => t >= CHECK_EVERY && k.close(true));
  const k = keeper(app, list);
  const checker = { status: "", check: async (l) => l.map((e) => ({ ...e, status: "timeout" })), stop: async () => {} };
  await k.background(checker);
  assert.deepEqual(queries(k), ["A", "B", "C"]);
  assert.ok(list.every((e) => !e.failed));
});
