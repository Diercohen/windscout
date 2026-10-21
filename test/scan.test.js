// Scan with fake probers (no VPN, no docker), against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { Scan } from "../dist/scan.js";

const OPTIONS = { timeout: 10, speedTest: false };
// XX doesn't exist; fails(query, protocol) makes this prober's container "stop"
const fake = (tried, fails = () => false) => async (query, protocol) => {
  tried.push(`${query} ${protocol}`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (fails(query, protocol)) throw new Error("container 2 stopped: gone");
  return { query, protocol, location: "", connectS: 1, latencyMs: 1, speedMbps: null, status: query === "XX" ? "no such location" : "ok" };
};

test("slots share the attempts, each runs once, and a missing country's other protocols are skipped", async () => {
  const tried = [];
  const scan = new Scan(["DE", "XX", "NL"], ["a", "b", "c"], OPTIONS, [fake(tried), fake(tried)]);
  await scan.run();
  assert.equal(scan.done, scan.total);
  assert.deepEqual([...scan.finished].sort(), ["DE", "NL", "XX"]);
  assert.equal(new Set(tried).size, tried.length);
  assert.ok(tried.filter((t) => t.startsWith("XX")).length <= 2); // at most what was running when the first came back
  assert.equal(scan.results.filter((r) => r.status === "ok").length, 6);
});

test("when a slot's container stops, the others take over its attempt", async () => {
  const tried = [];
  let stopped = false;
  const dies = () => !stopped && (stopped = true);
  const scan = new Scan(["DE", "NL"], ["a", "b"], OPTIONS, [fake(tried), fake(tried, dies)]);
  await scan.run();
  assert.equal(scan.done, 4);
  assert.deepEqual(scan.results.map((r) => `${r.query} ${r.protocol}`).sort(), ["DE a", "DE b", "NL a", "NL b"]);
  assert.deepEqual(scan.errors, ["container 2 stopped: gone"]);
});

test("stop lets the running attempts finish and starts no more", async () => {
  const tried = [];
  const scan = new Scan(["DE", "NL", "FR"], ["a", "b"], OPTIONS, [fake(tried), fake(tried)]);
  const run = scan.run();
  scan.stop();
  await run;
  assert.equal(scan.results.length, 2);
  assert.equal(tried.length, 2);
});

test("a pause waits for the running attempts, and doesn't count as elapsed", async () => {
  const scan = new Scan(["DE"], ["a", "b", "c"], OPTIONS, [fake([]), fake([])]);
  const run = scan.run(); // both slots start an attempt right away
  scan.togglePause(); // lands after them
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(scan.waiting, true);
  assert.equal(scan.results.length, 2);
  const elapsed = scan.elapsed();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(scan.elapsed() - elapsed < 0.01);
  scan.togglePause();
  await run;
  assert.equal(scan.done, 3);
});

test("protocols the slots can't make run after them, one at a time, and so does what dead slots leave", async () => {
  const log = [];
  const timed = (who, dies = () => false) => async (query, protocol) => {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (dies()) throw new Error(`${who} stopped`);
    log.push({ who, protocol, start, end: performance.now() });
    return { query, protocol, location: "", connectS: 1, latencyMs: 1, speedMbps: null, status: "ok" };
  };
  const here = { prober: timed("here"), protocols: new Set(["x"]), name: "this computer" };
  const scan = new Scan(["DE", "NL", "FR"], ["a", "x"], OPTIONS, [timed("slot"), timed("slot")], here);
  await scan.run();
  assert.equal(scan.done, 6);
  const slots = log.filter((l) => l.who === "slot"), after = log.filter((l) => l.who === "here");
  assert.deepEqual([slots.map((l) => l.protocol), after.map((l) => l.protocol)], [["a", "a", "a"], ["x", "x", "x"]]);
  assert.ok(after[0].start >= Math.max(...slots.map((l) => l.end)));
  after.forEach((l, i) => i && assert.ok(l.start >= after[i - 1].end));

  log.length = 0; // every container stops: this computer does the rest
  const dead = new Scan(["DE", "NL"], ["a", "x"], OPTIONS, [timed("slot", () => true)], here);
  await dead.run();
  assert.equal(dead.done, 4);
  assert.deepEqual(log.map((l) => l.who), ["here", "here", "here", "here"]);
});
