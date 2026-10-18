import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCATIONS, expandLocations, loadLocations, parseLocations } from "../dist/locations.js";

test("catalog parser merges country regions and ignores offline or invalid entries", () => {
  assert.deepEqual(parseLocations({ data: [
    { country_code: "US", groups: [{ city: "New York", nick: "Empire" }, { city: "Miami", nick: "Vice", status: 0 }] },
    { country_code: "US", groups: [{ city: "Los Angeles", nick: "Dogg" }, { city: "New York", nick: "Empire" }, { city: "Missing nickname" }] },
    { country_code: "DE", status: 0, groups: [{ city: "Berlin", nick: "Berghain" }] },
    { country_code: "invalid", groups: [{ city: "City", nick: "Name" }] },
    null,
  ] }), [
    { country: "US", city: "New York", nickname: "Empire" },
    { country: "US", city: "Los Angeles", nickname: "Dogg" },
  ]);
});

test("expansion handles lowercase country codes and deduplicates explicit nicknames", () => {
  assert.deepEqual(expandLocations(["us", "Empire", "US"], [
    { country: "US", city: "New York", nickname: "Empire" },
    { country: "US", city: "Miami", nickname: "Vice" },
  ]), [
    { country: "US", query: "Empire", location: "New York - Empire" },
    { country: "US", query: "Vice", location: "Miami - Vice" },
  ]);
});

test("bundled catalog covers US regions and other countries without network access", () => {
  const targets = expandLocations(["US", "DE", "NL"], LOCATIONS);
  for (const name of ["Missionary", "Lamar", "Empire", "Wurstchen", "Tulip"])
    assert.ok(targets.some((t) => t.query === name), name);
});

test("unreachable or malformed live catalogs fall back to bundled locations", async () => {
  for (const request of [
    async () => { throw new Error("offline"); },
    async () => new Response("{}"),
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response('{"data":[{"country_code":"US","groups":{}}]}'),
  ]) assert.deepEqual(await loadLocations(request), LOCATIONS);
});

test("a valid live catalog replaces stale bundled names", async () => {
  const loaded = await loadLocations(async () => Response.json({ data: [
    { country_code: "US", groups: [{ city: "New York", nick: "New Server" }] },
  ] }));
  assert.deepEqual(loaded, [{ country: "US", city: "New York", nickname: "New Server" }]);
});

test("a location limit applies independently to each country after deduplication", () => {
  const targets = expandLocations(["us", "US", "DE", "Empire"], [
    { country: "US", city: "New York", nickname: "Empire" },
    { country: "US", city: "New York", nickname: "Empire" },
    { country: "US", city: "Miami", nickname: "Vice" },
    { country: "US", city: "Los Angeles", nickname: "Lamar" },
    { country: "DE", city: "Berlin", nickname: "Berghain" },
    { country: "DE", city: "Frankfurt", nickname: "Wurstchen" },
  ], 2);
  assert.deepEqual(targets.map((t) => t.query), ["Empire", "Vice", "Berghain", "Wurstchen"]);
});

test("explicit nicknames share their country's cap and short country lists are not repeated", () => {
  assert.deepEqual(expandLocations(["Empire", "Vice", "Lamar", "DE", "ZZ"], [
    { country: "US", city: "New York", nickname: "Empire" },
    { country: "US", city: "Miami", nickname: "Vice" },
    { country: "US", city: "Los Angeles", nickname: "Lamar" },
    { country: "DE", city: "Berlin", nickname: "Berghain" },
  ], 2).map((t) => t.query), ["Empire", "Vice", "Berghain", "ZZ"]);
});
