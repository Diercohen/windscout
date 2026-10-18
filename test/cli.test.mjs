import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const run = (args) => spawnSync(process.execPath, [
  "--experimental-test-module-mocks", "--import", "./test/fixtures/cli-vpn.mjs", "dist/cli.js", ...args,
], { encoding: "utf8", timeout: 5000 });

test("invalid location limits fail before accessing Windscribe", () => {
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "abc", "", "9007199254740992"]) {
    const result = run(["-c", "US", `--limit=${value}`]);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /--limit must be a positive whole number/, value);
  }
});

test("help explains the short and long location-limit flags", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /-l, --limit.*per country/);
});

test("both CLI aliases cap each country and preserve protocol attempts", () => {
  for (const flag of ["-l", "--limit"]) {
    const result = run(["-c", "US,DE", flag, "1", "-p", "wireguard,tcp", "-n"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[1\/4\] US · New York - Empire wireguard/);
    assert.match(result.stdout, /\[4\/4\] DE · Berlin - Berghain tcp/);
    assert.doesNotMatch(result.stdout, /Miami|Wurstchen/);
  }
});
