// How many containers a parallel scan starts, against the build: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { containersFor } from "../dist/docker.js";

test("one container per attempt, and past the most, the fewest that need no more rounds", () => {
  const at16 = [1, 5, 16, 17, 20, 32, 33, 100].map((a) => containersFor(a, 16));
  assert.deepEqual(at16, [1, 5, 16, 9, 10, 16, 11, 15]);
  assert.deepEqual([5, 8, 9].map((a) => containersFor(a, 4)), [3, 4, 3]);
  for (let most = 1; most <= 16; most++) {
    for (let attempts = 1; attempts <= 200; attempts++) {
      const n = containersFor(attempts, most), rounds = Math.ceil(attempts / most);
      assert.ok(n >= 1 && n <= most);
      assert.equal(Math.ceil(attempts / n), rounds); // as fast as using them all
      assert.ok(n === 1 || Math.ceil(attempts / (n - 1)) > rounds); // one fewer would take another round
    }
  }
});

test("IKEv2, and WireGuard where the containers can't run it, stay on this computer, with or without a port", async () => {
  const { notInContainers } = await import("../dist/docker.js");
  const protocols = ["wireguard", "wireguard:53", "ikev2:500", "stealth:443", "wireguardx"];
  assert.deepEqual([...notInContainers(protocols, true)], ["ikev2:500"]);
  assert.deepEqual([...notInContainers(protocols, false)], ["wireguard", "wireguard:53", "ikev2:500"]);
});
