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

// windscribe-cli status, as the apps before 2.25 print it (macOS marks the connect state while it checks) and as 2.25 and newer do
const OLD = `Windscribe CLI client v2.24.4
*Connect state: Connected: Toronto - The 6 [Network interference]
Protocol: wireguard:443
VPN IP: 104.254.92.10
Firewall state: On
Login state: Logged in
`;
// (2.25.8 pads the labels to one width, and Windows ends lines with \r\n)
const NEW = `Login:       Logged in\r
Connection:  Connected to Toronto - The 6 (checking the connection)\r
Protocol:    wireguard:443\r
IP:          104.254.92.10 (VPN)\r
Firewall:    Always On\r
Data usage:  1.15 TB / Unlimited\r
Internet:    Available\r
`;

test("status: either app version's wording reads the same", async () => {
  const { connectStateOf, isFirewallOn, loginState, place, publicIpOf, statusValue, vpnIpOf } = await import("../dist/windscribe.js");
  for (const status of [OLD, NEW]) {
    assert.equal(connectStateOf(status), "Connected: Toronto - The 6");
    assert.equal(place(connectStateOf(status)), "Toronto - The 6");
    assert.equal(loginState(status), "Logged in");
    assert.equal(isFirewallOn(status), true);
    assert.equal(vpnIpOf(status), "104.254.92.10");
    assert.equal(publicIpOf(status), "");
  }
  assert.equal(connectStateOf("Connection: Connecting to Miami - Vice\n"), "Connecting: Miami - Vice");
  assert.equal(connectStateOf("Connect state: Connecting: Miami - Vice\n"), "Connecting: Miami - Vice");
  assert.equal(connectStateOf("Connection: Connected to Miami - Vice (network interference detected)\n"), "Connected: Miami - Vice");
  for (const state of ["Disconnected", "Disconnecting", "Error: Location does not exist or is disabled"]) {
    assert.equal(connectStateOf(`Login: Logged in\nConnection: ${state}\n`), state);
    assert.equal(connectStateOf(`Login state: Logged in\nConnect state: ${state}\n`), state);
  }
  assert.equal(publicIpOf("Connection: Disconnected\nIP: 1.2.3.4 (public)\n"), "1.2.3.4");
  assert.equal(publicIpOf("Connect state: Disconnected\nPublic IP: 1.2.3.4\n"), "1.2.3.4");
  assert.equal(isFirewallOn("Firewall: Off\n"), false);
  assert.equal(isFirewallOn("Firewall state: Off\n"), false);
  assert.equal(statusValue("Login: Logged in\n", "firewall"), ""); // not there
  assert.equal(loginState("Login state: Logging in\n"), "Logging in");
  assert.equal(connectStateOf(""), ""); // the app didn't answer
});
