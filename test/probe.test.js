// Stop at the first's hold: which round trips still count as holding up, against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { holding } from "../dist/probe.js";

const trips = (s) => [...s].map((c) => c === "+"); // "+": got through, "-": lost

test("a hold allows a lost round trip now and then, but not 2 in a row, or more than 1 in 10", () => {
  assert.equal(holding([]), true);
  assert.equal(holding(trips("++-++")), true); // one lost
  assert.equal(holding(trips("+--")), false); // an outage
  assert.equal(holding(trips("-+-")), false); // 2 lost of 3
  assert.equal(holding(trips("-++++++++++++++++++-")), true); // 2 lost of 20
  assert.equal(holding(trips("-+++++++++++++++++--")), false); // 3 of 20, and 2 in a row
  assert.equal(holding(trips("-++++-+++++-++++")), false); // 3 of 16
});
