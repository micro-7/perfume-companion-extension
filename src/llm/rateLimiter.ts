export interface RateLimiterOptions {
  perMinute: number;
  concurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  schedule<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Sliding-window limiter: at most `perMinute` calls start in any 60s window,
 * and at most `concurrency` run at once. Calls start in the order they were scheduled.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const perMinute = Math.max(1, Math.floor(opts.perMinute));
  const concurrency = opts.concurrency ?? 4;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const starts: number[] = [];
  let chain: Promise<void> = Promise.resolve();
  let active = 0;
  const waiting: Array<() => void> = [];

  async function takeSlot(): Promise<void> {
    for (;;) {
      const t = now();
      while (starts.length && t - starts[0] >= 60_000) starts.shift();
      if (starts.length < perMinute) {
        starts.push(t);
        return;
      }
      await sleep(60_000 - (t - starts[0]));
    }
  }

  function acquire(): Promise<void> {
    if (active < concurrency) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  return {
    async schedule<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        const slot = chain.then(takeSlot);
        chain = slot.catch(() => undefined);
        await slot;
        return await fn();
      } finally {
        release();
      }
    },
  };
}
