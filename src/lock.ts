import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LockOwner {
  token: string;
  pid: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isAlreadyLocked(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export class CrossProcessLock {
  constructor(
    private readonly lockDirectory: string,
    private readonly acquireTimeoutMs = 10_000,
  ) {}

  async acquire(): Promise<() => Promise<void>> {
    const parent = dirname(this.lockDirectory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.acquireTimeoutMs;
    const token = randomBytes(16).toString("hex");
    const owner: LockOwner = { token, pid: process.pid };

    while (true) {
      const claim = `${this.lockDirectory}.claim-${token}`;
      await mkdir(claim, { mode: 0o700 });
      await writeFile(join(claim, "owner.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
      try {
        await rename(claim, this.lockDirectory);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          const current = await this.readOwner(this.lockDirectory);
          if (current?.token !== token) return;
          await unlink(join(this.lockDirectory, "owner.json"));
          await rmdir(this.lockDirectory);
        };
      } catch (error) {
        await this.removeClaim(claim);
        if (!isAlreadyLocked(error)) throw error;
      }

      const current = await this.readOwner(this.lockDirectory);
      if (current && processIsDefinitelyDead(current.pid)) {
        await this.reclaimDeadOwner(current.token);
        continue;
      }
      if (Date.now() >= deadline) throw new Error("another OpenPaper Relay process is using this institutional browser profile");
      await delay(100);
    }
  }

  private async readOwner(directory: string): Promise<LockOwner | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")) as Partial<LockOwner>;
      if (typeof parsed.token !== "string" || !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return undefined;
      return parsed as LockOwner;
    } catch {
      return undefined;
    }
  }

  private async reclaimDeadOwner(expectedToken: string): Promise<void> {
    const quarantine = `${this.lockDirectory}.dead-${randomBytes(8).toString("hex")}`;
    try {
      await rename(this.lockDirectory, quarantine);
    } catch (error) {
      if (!isAlreadyLocked(error) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    const quarantinedOwner = await this.readOwner(quarantine);
    if (quarantinedOwner?.token !== expectedToken || !processIsDefinitelyDead(quarantinedOwner.pid)) {
      await rename(quarantine, this.lockDirectory).catch(() => undefined);
      return;
    }
    await unlink(join(quarantine, "owner.json"));
    await rmdir(quarantine);
  }

  private async removeClaim(claim: string): Promise<void> {
    await unlink(join(claim, "owner.json")).catch(() => undefined);
    await rmdir(claim).catch(() => undefined);
  }
}
