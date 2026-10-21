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
