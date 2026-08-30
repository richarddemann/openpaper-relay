import assert from "node:assert/strict";
import { mkdtemp, rename, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CrossProcessLock } from "../src/lock.js";

test("filesystem lock excludes another service instance and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-lock-"));
  const path = join(root, "site.lock");
  const release = await new CrossProcessLock(path, 100).acquire();
  await assert.rejects(new CrossProcessLock(path, 20).acquire(), /another OpenPaper Relay process/);
  await release();
  const releaseAgain = await new CrossProcessLock(path, 100).acquire();
  await releaseAgain();
});

test("an old owner token cannot release a successor's lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-lock-"));
  const path = join(root, "site.lock");
  const releaseFirst = await new CrossProcessLock(path, 100).acquire();
  const displaced = join(root, "displaced.lock");
  await rename(path, displaced);
  const releaseSecond = await new CrossProcessLock(path, 100).acquire();
  await releaseFirst();
  await assert.rejects(new CrossProcessLock(path, 20).acquire(), /another OpenPaper Relay process/);
  await releaseSecond();
  await unlink(join(displaced, "owner.json"));
  await rmdir(displaced);
});
