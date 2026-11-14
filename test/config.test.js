// The Windscribe login 0.6.0 saved, the saved choice, the scan screen's table and the last result, against the build: npm test
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
  assert.equal(c.hold, 30); // saved before the hold: its default
  writeFileSync(CONFIG, JSON.stringify({ order: "last-only", stopAtFirst: true, hold: 120 }));
  assert.deepEqual([loadConfig().order, loadConfig().stopAtFirst, loadConfig().hold], ["last-only", true, 120]);
  writeFileSync(CONFIG, JSON.stringify({ hold: 5 })); // under the least
  assert.equal(loadConfig().hold, 30);
  writeFileSync(CONFIG, JSON.stringify({ order: "sideways" }));
  assert.equal(loadConfig().order, "default");
});

test("the scan screen starts on the ranking until the user switches, then on the table it was left on", async () => {
  const { loadView, saveView } = await import("../dist/config.js");
  const file = join(dirname(CONFIG), "view.json");
  rmSync(file, { force: true });
  assert.equal(loadView(), "ranking");
  saveView("availability");
  assert.equal(loadView(), "availability");
  saveView("ranking");
  assert.equal(loadView(), "ranking");
  writeFileSync(file, JSON.stringify({ view: "sideways" }));
  assert.equal(loadView(), "ranking");
  writeFileSync(file, "not json");
  assert.equal(loadView(), "ranking");
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

test("the results screen saves the list with the ones whose last check failed at the end, after the saved ones it didn't have", async () => {
  const { loadLast, saveLast, LAST_FILE } = await import("../dist/config.js");
  rmSync(LAST_FILE, { force: true });
  const ok = (query, protocol, extra = {}) => ({ query, protocol, location: "", connectS: 1, latencyMs: 40, speedMbps: null, status: "ok", ...extra });
  saveLast([ok("DE", "tcp"), ok("NL", "udp")], 1000);
  const failed = ok("FR", "udp", { failed: "timeout", failedAt: 1500 });
  saveLast([ok("TR", "stealth", { checked: 1600 }), failed], 2000, new Set(["TR stealth", "FR udp", "DE tcp"]));
  assert.deepEqual(loadLast().results.map((r) => r.query), ["TR", "NL", "FR"]);
  assert.equal(loadLast().results[2].failed, "timeout"); // older versions read it as a working one, and try it last
  assert.equal(loadLast().results[0].checked, 1600);
});

test("settings are merged into the saved ones, and the results screen's start as watch on, background checks as docker is", async () => {
  const { loadConfig, loadSettings, saveConfig } = await import("../dist/config.js");
  rmSync(CONFIG, { force: true });
  assert.deepEqual(loadSettings(), { watch: true, background: false });
  saveConfig({ countries: ["DE"], protocols: ["tcp"], docker: true });
  assert.deepEqual(loadSettings(), { watch: true, background: true });
  saveConfig({ watch: false, background: false });
  assert.deepEqual(loadSettings(), { watch: false, background: false });
  assert.deepEqual([loadConfig().countries, loadConfig().docker], [["DE"], true]); // the picker's are still there
  saveConfig({ countries: ["NL"] }); // the picker saving keeps the results screen's
  assert.deepEqual(loadSettings(), { watch: false, background: false });
  writeFileSync(CONFIG, "not json");
  assert.deepEqual(loadSettings(), { watch: true, background: false });
});
