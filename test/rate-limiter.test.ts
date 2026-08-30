import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistentSlidingWindowRateLimiter, SlidingWindowRateLimiter } from "../src/rate-limiter.js";

test("rate limiter permits the configured window and recovers after expiry", () => {
  let now = 1_000;
  const limiter = new SlidingWindowRateLimiter(2, 100, () => now);
  limiter.take();
  limiter.take();
  assert.throws(() => limiter.take(), /rate limit exceeded/);
  now += 101;
  assert.doesNotThrow(() => limiter.take());
});

test("persistent rate limiter survives a new limiter instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-rate-"));
  const ledger = join(root, "rate.json");
  await new PersistentSlidingWindowRateLimiter(ledger, 1, 3_600_000, () => 10_000).take();
  await assert.rejects(
    new PersistentSlidingWindowRateLimiter(ledger, 1, 3_600_000, () => 10_001).take(),
    /rate limit exceeded/,
  );
});
