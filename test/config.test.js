// The Windscribe login 0.6.0 saved, against the build: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("a saved speed-test choice is kept, and the rest of the choice stays", async () => {
  const { loadConfig } = await import("../dist/config.js");
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify({ countries: ["DE"], protocols: ["tcp"], speed: true, random: true, timeout: 20 }));
  const c = loadConfig();
  assert.equal(c.speed, true);
  assert.deepEqual([c.countries, c.protocols, c.random, c.timeout], [["DE"], ["tcp"], true, 20]);
});
