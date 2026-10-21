// The remembered Windscribe login, against the build: npm test
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "windscout-test-")); // before config.js reads it
const { LOGIN_FILE, loadLogin, saveLogin } = await import("../dist/config.js");

test("the login file is readable only by its owner, even over an older one, and forgetting removes it", () => {
  assert.equal(loadLogin(), null);
  mkdirSync(dirname(LOGIN_FILE), { recursive: true });
  writeFileSync(LOGIN_FILE, "{}", { mode: 0o644 });
  saveLogin({ username: "dier", password: "correct horse" });
  assert.deepEqual(loadLogin(), { username: "dier", password: "correct horse" });
  if (process.platform !== "win32") assert.equal(statSync(LOGIN_FILE).mode & 0o777, 0o600);
  saveLogin(null);
  assert.equal(existsSync(LOGIN_FILE), false);
});
