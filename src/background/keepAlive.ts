/**
 * Chrome stops an extension's background worker after about 30 seconds without activity. A lookup
 * can wait much longer than that (requests are spaced out to stay inside Gemini's free limit), and
 * a stopped worker loses everything it was doing. While any lookup is running, `ping` (an extension
 * API call, which counts as activity) is called every `intervalMs`.
 */
export const KEEP_ALIVE_MS = 20_000;

export interface KeepAlive {
  /** true when a lookup starts, false when one ends. Overlapping lookups are counted. */
  setBusy(busy: boolean): void;
  /** Number of lookups currently running. */
  readonly active: number;
}

export function createKeepAlive(ping: () => void, intervalMs: number = KEEP_ALIVE_MS): KeepAlive {
  let busy = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    setBusy(isBusy: boolean): void {
      busy = Math.max(0, busy + (isBusy ? 1 : -1));
      if (busy > 0 && timer === undefined) {
        timer = setInterval(ping, intervalMs);
      } else if (busy === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    get active() {
      return busy;
    },
  };
}
