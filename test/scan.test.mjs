import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Keep VPN connections outside the tests; exercise the real scheduler and tables.
mock.module("../dist/probe.js", {
  namedExports: {
    probe: async (query, protocol) => ({
      query, protocol, location: "", connectS: null, latencyMs: null,
      speedMbps: null, status: query === "Missionary" ? "no such location" : "ok",
    }),
    sortOk: (results) => results.filter((r) => r.status === "ok"),
  },
});
const { Scan } = await import("../dist/scan.js");
const { matrix } = await import("../dist/tui/tables.js");
const locations = [
  { country: "US", city: "Salt Lake City", nickname: "Missionary" },
  { country: "US", city: "Los Angeles", nickname: "Lamar" },
  { country: "DE", city: "Frankfurt", nickname: "Wurstchen" },
  { country: "DE", city: "Berlin", nickname: "Berghain" },
];
const options = { timeout: 15, speedTest: false, locations };

test("each selected country scans every distinct location and protocol", async () => {
  const scan = new Scan(["US", "DE"], ["wireguard", "tcp:443"], options);
  const results = await scan.run();
  assert.deepEqual(results.map((r) => [r.query, r.protocol, r.country]), [
    ["Missionary", "wireguard", "US"],
    ["Lamar", "wireguard", "US"], ["Lamar", "tcp:443", "US"],
    ["Wurstchen", "wireguard", "DE"], ["Wurstchen", "tcp:443", "DE"],
    ["Berghain", "wireguard", "DE"], ["Berghain", "tcp:443", "DE"],
  ]);
  assert.equal(scan.total, 8);
  assert.equal(scan.done, 8);
});

test("explicit nicknames stay specific and unknown countries retain a fallback", async () => {
  const scan = new Scan(["Lamar", "ZZ"], ["tcp"], options);
  assert.deepEqual((await scan.run()).map((r) => r.query), ["Lamar", "ZZ"]);
});

test("stop finishes the current attempt without trying the next location", async () => {
  const scan = new Scan(["US"], ["tcp"], options);
  await scan.run({ result: () => scan.stop() });
  assert.equal(scan.results.length, 1);
  assert.equal(scan.results[0].query, "Missionary");
  assert.equal(scan.done, 1);
});

test("pause between datacenters resumes without skipping a location", async () => {
  const scan = new Scan(["US", "DE"], ["tcp"], { ...options, locations: [locations[1], locations[2]] });
  const run = scan.run({ result: () => { if (scan.done === 1) scan.togglePause(); } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scan.waiting, true);
  assert.equal(scan.results.length, 1);
  scan.togglePause();
  await run;
  assert.deepEqual(scan.results.map((r) => r.query), ["Lamar", "Wurstchen"]);
  assert.equal(scan.done, 2);
});

test("availability keeps failure and success for different datacenters separate", () => {
  const result = (query, location, status) => ({
    query, country: "US", location, status, protocol: "tcp",
    connectS: null, latencyMs: null, speedMbps: null,
  });
  const output = matrix([
    result("Missionary", "Salt Lake City - Missionary", "failed"),
    result("Lamar", "Los Angeles - Lamar", "ok"),
  ], ["tcp"]).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(output, /Salt Lake City - Missionary[^\n]*✗/);
  assert.match(output, /Los Angeles - Lamar[^\n]*✓/);
  assert.match(output, /1\/1 countries reachable/);
});

test("location limit caps datacenters per country while keeping every protocol", async () => {
  const scan = new Scan(["US", "DE"], ["wireguard", "tcp"], { ...options, limit: 1 });
  assert.equal(scan.total, 4);
  const results = await scan.run();
  assert.deepEqual(results.map((r) => [r.query, r.protocol]), [
    ["Missionary", "wireguard"], ["Wurstchen", "wireguard"], ["Wurstchen", "tcp"],
  ]);
  assert.equal(scan.done, 4);
});
