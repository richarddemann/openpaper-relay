export class RateLimitError extends Error {
  constructor(limit: number, windowMs: number) {
    super(`rate limit exceeded: at most ${limit} fetches per ${windowMs / 60_000} minutes`);
    this.name = "RateLimitError";
  }
}

export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.timestamps[0] !== undefined && this.timestamps[0] <= cutoff) this.timestamps.shift();
    if (this.timestamps.length >= this.limit) {
      throw new RateLimitError(this.limit, this.windowMs);
    }
    this.timestamps.push(this.now());
  }
}

export class PersistentSlidingWindowRateLimiter {
  constructor(
    private readonly ledgerPath: string,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async take(): Promise<void> {
    await mkdir(dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.ledgerPath), 0o700);
    let stored: unknown = [];
    try {
      stored = JSON.parse(await readFile(this.ledgerPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!Array.isArray(stored) || !stored.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("rate-limit ledger is invalid");
    }
    const now = this.now();
    const timestamps = stored.filter((value) => value > now - this.windowMs && value <= now);
    if (timestamps.length >= this.limit) {
      throw new RateLimitError(this.limit, this.windowMs);
    }
    timestamps.push(now);
    const temporary = `${this.ledgerPath}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(timestamps), { mode: 0o600, flag: "wx" });
    await rename(temporary, this.ledgerPath);
    await chmod(this.ledgerPath, 0o600);
  }
}
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
