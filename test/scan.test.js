// Scan with fake probers (no VPN, no docker), against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { plan, Scan } from "../dist/scan.js";

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

test("given its attempts (a plan), a scan tries only those, in order, and each country finishes after its own", async () => {
  const tried = [];
  const only = [{ country: "DE", protocol: "a" }, { country: "NL", protocol: "b:443" }, { country: "NL", protocol: "a" }];
  const scan = new Scan(["DE", "NL"], ["a", "b:443"], { ...OPTIONS, only }, [fake(tried)]);
  await scan.run();
  assert.equal(scan.total, 3);
  assert.deepEqual(tried, ["DE a", "NL b:443", "NL a"]);
  assert.deepEqual(scan.finished, ["DE", "NL"]);
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

test("a slot per container and no more, and when every container stops, the scan ends there and says why", async () => {
  const tried = [];
  const scan = new Scan(["DE", "NL"], ["a", "b"], OPTIONS, [fake(tried, () => true), fake(tried, () => true)]);
  assert.equal(scan.slots.length, 2);
  await scan.run();
  assert.deepEqual([scan.total, scan.done, scan.results.length, tried.length], [4, 0, 0, 2]);
  assert.deepEqual([...new Set(scan.errors)], ["container 2 stopped: gone"]);
});

const pairs = (attempts) => attempts.map((a) => `${a.country} ${a.protocol}`);
const PORTS = new Map([["tcp", [443, 587]], ["stealth", [443]]]); // each protocol's ports, its default first
const SAVED = [ // the last result, best first
  { query: "NL", protocol: "stealth" }, // NL isn't selected below
  { query: "DE", protocol: "tcp:587" }, // on a port of its own
  { query: "DE", protocol: "udp" }, // udp isn't selected below
  { query: "FR", protocol: "tcp:443" }, // tcp's default port: the same attempt as "FR tcp"
];

test("by last success result first: the saved connections among the selection go first, best first and on their ports, then the rest, each once", () => {
  const one = plan("last-first", ["DE"], ["stealth", "tcp"], SAVED, PORTS); // one country selected: only it is scanned
  assert.deepEqual(pairs(one), ["DE tcp:587", "DE stealth", "DE tcp"]);
  assert.deepEqual(one.map((a) => Boolean(a.saved)), [true, false, false]);
  assert.deepEqual(pairs(plan("last-first", ["DE", "FR"], ["stealth", "tcp"], SAVED, PORTS)),
    ["DE tcp:587", "FR tcp:443", "DE stealth", "DE tcp", "FR stealth"]);
  assert.deepEqual(plan("last-first", ["DE", "FR"], ["stealth"]), plan("default", ["DE", "FR"], ["stealth"])); // nothing saved
});

test("only the last results: the saved connections, best first and each once, whatever is selected", () => {
  const all = plan("last-only", ["DE"], ["stealth"], [...SAVED, { query: "FR", protocol: "tcp" }], PORTS);
  assert.deepEqual(pairs(all), ["NL stealth", "DE tcp:587", "DE udp", "FR tcp:443"]);
  assert.ok(all.every((a) => a.saved));
});

test("default and by random country: every country × protocol, random shuffling the countries but keeping each one's protocols together", () => {
  const countries = ["DE", "NL", "FR", "TR", "AE", "GB"], protocols = ["a", "b"];
  const listed = plan("default", countries, protocols, SAVED, PORTS); // the saved connections don't matter here
  assert.deepEqual(pairs(listed), countries.flatMap((c) => protocols.map((p) => `${c} ${p}`)));
  const shuffled = plan("random", countries, protocols, SAVED, PORTS);
  assert.deepEqual(pairs(shuffled).sort(), pairs(listed).sort());
  for (let i = 0; i < shuffled.length; i += 2) assert.equal(shuffled[i].country, shuffled[i + 1].country);
});

test("stop at the first: the probes check each connection holds up, and the scan stops at the first reliable one", async () => {
  const tried = [], steady = [];
  const result = (query, protocol, status, speedMbps) => ({ query, protocol, location: "", connectS: 1, latencyMs: 1, speedMbps, status });
  const prober = async (query, protocol, options) => {
    tried.push(`${query} ${protocol}`);
    steady.push(options.steady);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (query === "DE") return result(query, protocol, "unreliable", 20); // connected, then dropped
    if (query === "NL") return result(query, protocol, "ok", 0.5); // works, but too slow to stop at
    if (query === "FR") return result(query, protocol, "ok", 30);
    while (!options.stopped()) await new Promise((resolve) => setTimeout(resolve, 1)); // still connecting when FR holds up
    return result(query, protocol, "interrupted", null);
  };
  const scan = new Scan(["DE", "NL", "FR", "TR", "GB"], ["a"], { ...OPTIONS, stopAtFirst: true }, [prober]);
  await scan.run();
  assert.equal(scan.found, true);
  assert.deepEqual(tried, ["DE a", "NL a", "FR a"]); // TR and GB never start
  assert.ok(steady.every(Boolean));

  tried.length = 0; // two slots: TR, running when FR holds up, gives up
  const parallel = new Scan(["TR", "FR", "GB"], ["a"], { ...OPTIONS, stopAtFirst: true }, [prober, prober]);
  await parallel.run();
  assert.deepEqual(parallel.results.map((r) => `${r.query} ${r.status}`).sort(), ["FR ok", "TR interrupted"]);

  const all = new Scan(["DE", "NL", "FR"], ["a"], OPTIONS, [fake([])]); // off: every attempt, no check
  await all.run();
  assert.deepEqual([all.done, all.found], [3, false]);
});
