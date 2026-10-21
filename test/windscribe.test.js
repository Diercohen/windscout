// The Windscribe app's settings file, which the docker containers' apps get this computer's session in, against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { iniValue, withSession } from "../dist/windscribe.js";

const SESSION = { userId: "abc123", authHash: "123456789:1:1760000000:aa11:bb22" };

test("a new volume's settings get just the session", () => {
  assert.equal(withSession("", SESSION), `[General]\nauthHash=${SESSION.authHash}\n`);
});

test("the same account's settings keep everything but the old session", () => {
  const ini = '[General]\nauthHash=old\nuserId=abc123\nwireguardConfig=@ByteArray(keys)\n\n[engine]\nauthHash=not-this-one\n';
  const out = withSession(ini, SESSION);
  assert.equal(out, `[General]\nauthHash=${SESSION.authHash}\nuserId=abc123\nwireguardConfig=@ByteArray(keys)\n\n[engine]\nauthHash=not-this-one\n`);
  assert.equal(iniValue(out, "authHash"), SESSION.authHash);
});

test("another account's settings start over: their WireGuard keys are that account's", () => {
  const ini = "[General]\nauthHash=old\nuserId=someone-else\nwireguardConfig=@ByteArray(keys)\n";
  assert.equal(withSession(ini, SESSION), `[General]\nauthHash=${SESSION.authHash}\n`);
});

test("settings are kept when this computer's account can't be read", () => {
  const ini = "[General]\nuserId=someone\nwireguardConfig=x\n";
  assert.equal(withSession(ini, { ...SESSION, userId: "" }), `[General]\nauthHash=${SESSION.authHash}\nuserId=someone\nwireguardConfig=x\n`);
});

test("values are read from [General] only, and a file without one gets one", () => {
  assert.equal(iniValue("[engine]\nuserId=a\n[General]\r\nuserId=b\r\n", "userId"), "b");
  assert.equal(iniValue("[engine]\nuserId=a\n", "userId"), undefined);
  assert.equal(withSession("[engine]\nfoo=1\n", { ...SESSION, userId: "" }), `[General]\nauthHash=${SESSION.authHash}\n[engine]\nfoo=1\n`);
});

test("all ports: each protocol without a port goes on every port the app lists, the rest stay as given", async () => {
  const { withPorts } = await import("../dist/windscribe.js");
  const lists = new Map([["tcp", [443, 587]], ["wstunnel", [443]], ["ikev2", []]]);
  assert.deepEqual(withPorts(["tcp", "stealth:8443", "wstunnel", "ikev2", "stealth"], lists),
    ["tcp:443", "tcp:587", "stealth:8443", "wstunnel:443", "ikev2", "stealth"]);
});
