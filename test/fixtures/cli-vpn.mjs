// Run the real CLI without changing the host VPN or depending on network access.
import { mock } from "node:test";
import * as windscribe from "../../dist/windscribe.js";
import * as probe from "../../dist/probe.js";

mock.module("../../dist/windscribe.js", {
  namedExports: {
    ...windscribe,
    waitForLogin: async () => "Login state: Logged in\nFirewall state: Off",
    windscribe: async () => { throw new Error("Tests must not control the host VPN"); },
    restoreFirewall: async () => {},
  },
});
mock.module("../../dist/probe.js", {
  namedExports: {
    ...probe,
    probe: async (query, protocol) => ({
      query, protocol, location: "", connectS: 1, latencyMs: 10, speedMbps: null, status: "ok",
    }),
  },
});
globalThis.fetch = async (url) => Response.json(String(url).includes("serverlist")
  ? { data: [
    { country_code: "US", groups: [{ city: "New York", nick: "Empire" }, { city: "Miami", nick: "Vice" }] },
    { country_code: "DE", groups: [{ city: "Berlin", nick: "Berghain" }, { city: "Frankfurt", nick: "Wurstchen" }] },
  ] }
  : { version: "0.5.7" });
