import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './rateLimiter';

describe('createRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at most N calls per minute: 12 calls at 10/min spill into the next minute', async () => {
    const limiter = createRateLimiter({ perMinute: 10 });
    const t0 = Date.now();
    const starts: number[] = [];
    const calls = Array.from({ length: 12 }, () =>
      limiter.schedule(async () => {
        starts.push(Date.now() - t0);
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(10);
    expect(Math.max(...starts)).toBeLessThan(60_000);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(starts).toHaveLength(10);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(calls);
    expect(starts).toHaveLength(12);
    expect(starts[10]).toBeGreaterThanOrEqual(60_000);
    expect(starts[11]).toBeGreaterThanOrEqual(60_000);
  });

  it('runs at most 4 calls at the same time', async () => {
    const limiter = createRateLimiter({ perMinute: 100 });
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 10 }, () =>
      limiter.schedule(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 100));
        active--;
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(calls);
    expect(peak).toBe(4);
  });

  it('keeps going after a call fails', async () => {
    const limiter = createRateLimiter({ perMinute: 5 });
    await expect(limiter.schedule(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.schedule(async () => 'fine')).resolves.toBe('fine');
  });
});
