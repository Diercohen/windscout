// The watch after connecting, with a fake app and clock (no VPN), against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { Watch, WATCH_GAP, WATCH_KEEP, WATCH_MISSES, WATCH_RETRY } from "../dist/watch.js";

const LIST = ["A", "B", "C"].map((q) => ({ query: q, protocol: "wireguard", location: `${q}ville - ${q}`, connectS: 1, latencyMs: 40, speedMbps: 9, status: "ok" }));
const TOLD = "ConnectionManager::clickDisconnect()\n";

// A fake app connected to LIST[on] (-1: none). The clock moves only when the watch sleeps; then at(t) can change the app.
// Like the real one, the app logs each disconnect it's told to make, the watch's own too
function fakeApp(at) {
  const app = {
    t: 0, on: 0, internet: true, elsewhere: "", log: "",
    tried: [], // [from, t] of each connect
    answers: [], // what the next connects give: the index that connected, or -1; when there are none, from connects
    drops: [], // [why, lasted] the watch saw
    nones: 0,
    state: async () => (app.on < 0 ? "Disconnected" : `Connected: ${app.elsewhere || LIST[app.on].location}`),
    ping: async () => (app.on >= 0 && app.internet ? 40 : null),
    connect: async (from) => {
      app.tried.push([from, app.t]);
      app.on = app.answers.length ? app.answers.shift() : from;
      app.internet = true;
      return app.on;
    },
    disconnect: async () => ((app.on = -1), (app.log += TOLD)),
    logSize: () => app.log.length,
    told: (size) => app.log.slice(size).includes(TOLD),
    sleep: async (seconds, signal) => {
      if (signal.aborted) throw new Error("aborted");
      app.t += seconds;
      at(app.t, app);
    },
    now: () => app.t,
  };
  return app;
}

const watch = (app, i = 0) => {
  const w = new Watch(LIST, i, app, { dropped: (why, lasted) => app.drops.push([why, lasted]), none: () => app.nones++ });
  app.stop = () => w.stop();
  return w;
};

test(`a blip isn't a drop; ${WATCH_MISSES} checks in a row are, and one that dropped soon goes after the others`, async () => {
  const app = fakeApp((t, app) => {
    if (t === 30) app.internet = false; // checks at 30 and 33 miss, 36 gets through
    if (t === 36) app.internet = true;
    if (t === 60) app.on = -1; // dropped by itself: no TOLD
    if (t === 120) app.stop();
  });
  const w = watch(app);
  await w.run();
  const dropAt = 60 + (WATCH_MISSES - 1) * WATCH_GAP;
  assert.deepEqual(app.drops, [["Disconnected", dropAt]]);
  assert.deepEqual(app.tried, [[1, dropAt]]);
  assert.equal(w.i, 1);
  assert.equal(w.drops, 1);
  assert.equal(w.why, "");
  assert.equal(app.on, 1); // q leaves it connected
});

test("one that lasted is tried again first; when none connects, all are tried again from the best after a wait", async () => {
  const app = fakeApp((t, app) => {
    if (t === WATCH_KEEP) app.internet = false; // connected, no internet through it
    if (t > WATCH_KEEP + 60) app.stop();
  });
  app.on = 1;
  app.answers = [-1, 2];
  const w = watch(app, 1);
  await w.run();
  const dropAt = WATCH_KEEP + (WATCH_MISSES - 1) * WATCH_GAP;
  assert.deepEqual(app.drops, [["no internet through it", dropAt]]);
  assert.deepEqual(app.tried, [[1, dropAt], [0, dropAt + WATCH_RETRY]]);
  assert.equal(app.nones, 1);
  assert.equal(w.i, 2);
});

test("its own disconnects aren't yours: after connecting again, a drop is still a drop", async () => {
  const again = 30 + WATCH_MISSES * WATCH_GAP; // the first check after connecting again, with the watch's disconnect just logged
  const app = fakeApp((t, app) => {
    if (t === 30 || t === again) app.on = -1;
    if (t === 150) app.stop();
  });
  const w = watch(app);
  await w.run();
  assert.equal(w.drops, 2);
  assert.equal(w.why, "");
});

test("disconnecting in the app, or connecting it elsewhere, stops the watch at once and leaves the app alone", async () => {
  for (const [change, why] of [
    [(app) => ((app.on = -1), (app.log += TOLD)), /told to disconnect/],
    [(app) => (app.elsewhere = "Otherville - O"), /connected to Otherville - O/],
  ]) {
    const app = fakeApp((t, app) => {
      if (t === 30) change(app);
      if (t > 300) app.stop();
    });
    const w = watch(app);
    await w.run();
    assert.match(w.why, why);
    assert.equal(app.t, 30);
    assert.deepEqual(app.drops, []);
    assert.deepEqual(app.tried, []);
  }
});

test("q stops it while it waits", async () => {
  const app = fakeApp(() => {});
  app.sleep = (_, signal) => new Promise((_, reject) => signal.addEventListener("abort", reject));
  const w = watch(app);
  const run = w.run();
  setTimeout(() => w.stop(), 10);
  await run;
  assert.equal(w.stopped, true);
  assert.equal(w.why, "");
});
