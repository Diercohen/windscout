import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock, test } from "node:test";
import * as config from "../dist/config.js";

const input = new EventEmitter();
const out = Object.assign(new EventEmitter(), { rows: 40 });
let screen = "";
mock.module("../dist/tui/terminal.js", { namedExports: {
  input, out, repoLink: "", enterScreen() {}, leaveScreen() {},
  draw(lines) { screen = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, ""); return { left: 0, top: 0 }; },
} });
mock.module("../dist/config.js", { namedExports: { ...config, saveConfig() {} } });
mock.module("../dist/update.js", { namedExports: {
  canUpdate: () => false, checkUpdate: async () => {}, versionLines: () => [],
} });
const { pick } = await import("../dist/tui/picker.js");

test("picker counts and attempt estimates honor the per-country limit", async () => {
  const saved = { countries: ["US", "DE"], protocols: ["wireguard", "tcp"], timeout: 15, speed: false, firewall: false };
  const choice = pick(saved, { timeout: 15, speedTest: false, firewall: false, limit: 1, locations: [
    { country: "US", city: "New York", nickname: "Empire" },
    { country: "US", city: "Miami", nickname: "Vice" },
    { country: "DE", city: "Berlin", nickname: "Berghain" },
    { country: "DE", city: "Frankfurt", nickname: "Wurstchen" },
  ] });
  assert.match(screen, /United States \(1\/2 locations\)/);
  assert.match(screen, /Germany \(1\/2 locations\)/);
  assert.match(screen, /4 attempts/);
  input.emit("keypress", undefined, { name: "return" });
  assert.deepEqual((await choice).countries, ["US", "DE"]);
});
