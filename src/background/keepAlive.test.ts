import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeepAlive, KEEP_ALIVE_MS } from './keepAlive';

describe('keep-alive (Chrome stops an idle worker after ~30 s)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings every 20 seconds while a lookup runs, which is more often than Chrome\'s 30 s limit', () => {
    expect(KEEP_ALIVE_MS).toBeLessThan(30_000);
    const ping = vi.fn();
    const ka = createKeepAlive(ping);
    ka.setBusy(true);
    vi.advanceTimersByTime(19_999);
    expect(ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(ping).toHaveBeenCalledTimes(4); // a 2 minute lookup would never sit idle for 30 s
  });

  it('does nothing when no lookup is running', () => {
    const ping = vi.fn();
    createKeepAlive(ping);
    vi.advanceTimersByTime(120_000);
    expect(ping).not.toHaveBeenCalled();
  });

  it('stops pinging as soon as the last lookup ends (so an idle extension can rest)', () => {
    const ping = vi.fn();
    const ka = createKeepAlive(ping);
    ka.setBusy(true);
    vi.advanceTimersByTime(20_000);
    ka.setBusy(false);
    vi.advanceTimersByTime(120_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ka.active).toBe(0);
  });

  it('keeps pinging while any one of several overlapping lookups is still running', () => {
    const ping = vi.fn();
    const ka = createKeepAlive(ping);
    ka.setBusy(true);
    ka.setBusy(true);
    ka.setBusy(false);
    vi.advanceTimersByTime(20_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ka.active).toBe(1);
    ka.setBusy(false);
    vi.advanceTimersByTime(60_000);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('uses one timer however many lookups start, and can start again later', () => {
    const ping = vi.fn();
    const ka = createKeepAlive(ping);
    ka.setBusy(true);
    ka.setBusy(true);
    vi.advanceTimersByTime(20_000);
    expect(ping).toHaveBeenCalledTimes(1); // not twice
    ka.setBusy(false);
    ka.setBusy(false);
    ka.setBusy(true);
    vi.advanceTimersByTime(20_000);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('never counts below zero if a stop arrives without a start', () => {
    const ka = createKeepAlive(vi.fn());
    ka.setBusy(false);
    expect(ka.active).toBe(0);
  });
});
