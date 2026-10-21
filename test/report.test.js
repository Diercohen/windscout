// The final report, against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { report } from "../dist/tui/report.js";

const result = (query, protocol, status, more = {}) =>
  ({ query, protocol, location: "", connectS: null, latencyMs: null, speedMbps: null, status, ...more });

test("WireGuard attempts at the key limit show as such, don't count as tried, and get the command that tries them here", () => {
  const lines = [], log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    report([
      result("DE", "stealth", "ok", { location: "Frankfurt - Castle", connectS: 1, latencyMs: 50 }),
      result("DE", "wireguard", "key limit"),
      result("NL", "wireguard", "key limit"),
      result("NL", "stealth", "failed"),
    ], ["stealth", "wireguard"], { all: false, speedTest: false });
  } finally {
    console.log = log;
  }
  const out = lines.join("\n");
  assert.match(out, /Germany.*✓.*key limit/);
  assert.match(out, /Netherlands.*✗.*key limit/);
  assert.match(out, /2 WireGuard attempts hit your Windscribe account's limit/);
  assert.ok(out.includes('windscout -c "DE,NL" -p wireguard'));
  assert.match(out, /wireguard\s*│\s*0\/0/); // per protocol: none tried
});

test("all ports: a protocol's ports share its column, which counts the ports that worked of those really tried", async () => {
  const { matrix } = await import("../dist/tui/tables.js");
  const rows = matrix([
    result("DE", "tcp:443", "ok", { location: "Frankfurt - Castle" }),
    result("DE", "tcp:80", "timeout"),
    result("DE", "tcp:8443", "no such port"),
    result("DE", "stealth", "failed"),
    result("NL", "tcp:443", "failed"),
    result("NL", "tcp:80", "failed"),
    result("NL", "stealth", "ok", { location: "Amsterdam - Tulip" }),
  ], ["tcp:443", "tcp:80", "tcp:8443", "stealth"]).join("\n");
  assert.match(rows, /│\s+tcp\s+│\s+stealth\s+│/); // one column for tcp's three ports
  assert.match(rows, /Germany.*✓ 1\/2.*✗/);
  assert.match(rows, /Netherlands.*✗ 0\/2.*✓/);
  const one = matrix([result("DE", "tcp:9999", "no such port")], ["tcp:9999"]).join("\n");
  assert.match(one, /│ tcp:9999 │/); // a single port keeps its name
  assert.match(one, /Germany.*no port/);
});
