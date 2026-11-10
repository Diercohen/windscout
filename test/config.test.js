// The Windscribe login 0.6.0 saved, the saved choice and the last result, against the build: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "windscout-test-")); // before config.js reads it
const { CONFIG, forgetLogin } = await import("../dist/config.js");

test("the username and password 0.6.0 saved are deleted, and nothing else", () => {
  const login = join(dirname(CONFIG), "login.json");
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(login, JSON.stringify({ username: "dier", password: "correct horse" }));
  writeFileSync(CONFIG, "{}");
  forgetLogin();
  assert.equal(existsSync(login), false);
  assert.equal(existsSync(CONFIG), true);
  forgetLogin(); // none left: fine
});

test("a saved choice is kept: speed test, scanning type (random on, from before, reads as random) and the rest", async () => {
  const { loadConfig } = await import("../dist/config.js");
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ countries: ["DE"], protocols: ["tcp"], speed: true, random: true, timeout: 20 }));
  const c = loadConfig();
  assert.equal(c.speed, true);
  assert.deepEqual([c.countries, c.protocols, c.order, c.stopAtFirst, c.timeout], [["DE"], ["tcp"], "random", false, 20]);
  writeFileSync(CONFIG, JSON.stringify({ order: "last-only", stopAtFirst: true }));
  assert.deepEqual([loadConfig().order, loadConfig().stopAtFirst], ["last-only", true]);
  writeFileSync(CONFIG, JSON.stringify({ order: "sideways" }));
  assert.equal(loadConfig().order, "default");
});

test("the last result's working connections are saved best first, a scan keeps the ones it didn't try, and one where nothing worked keeps them all", async () => {
  const { loadLast, saveLast, LAST_FILE } = await import("../dist/config.js");
  rmSync(LAST_FILE, { force: true });
  assert.equal(loadLast(), null);
  const ok = (query, protocol, latencyMs) => ({ query, protocol, location: "", connectS: 1, latencyMs, speedMbps: null, status: "ok" });
  saveLast([ok("DE", "tcp:443", 40), ok("NL", "stealth", 60)], 1000);
  assert.deepEqual(loadLast(), { at: 1000, results: [ok("DE", "tcp:443", 40), ok("NL", "stealth", 60)] });
  saveLast([], 2000);
  assert.equal(loadLast().at, 1000);
  // stopped after trying DE tcp:443 (failed) and FR udp (worked): NL stealth wasn't reached, so it stays
  saveLast([ok("FR", "udp", 30)], 3000, new Set(["DE tcp:443", "FR udp"]));
  assert.deepEqual(loadLast(), { at: 3000, results: [ok("FR", "udp", 30), ok("NL", "stealth", 60)] });
  saveLast([], 4000, new Set(["FR udp", "NL stealth"])); // tried them, nothing worked: the network may be down, so they stay
  assert.equal(loadLast().at, 3000);
  writeFileSync(LAST_FILE, "not json");
  assert.equal(loadLast(), null);
});
