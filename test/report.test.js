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
