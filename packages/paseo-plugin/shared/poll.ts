/** Status polling cadence: steady while the gateway is up, exponential backoff while it is down. */

export const POLL_UP_MS = 15_000;
export const POLL_MAX_MS = 120_000;

/** `downStreak` = consecutive failed checks (0 when the last check succeeded). */
export function nextPollDelay(downStreak: number): number {
  if (!Number.isFinite(downStreak) || downStreak <= 0) {
    return POLL_UP_MS;
  }
  const exponent = Math.min(Math.floor(downStreak) - 1, 10);
  return Math.min(POLL_UP_MS * 2 ** exponent, POLL_MAX_MS);
}

export interface StatusLike {
  readonly up: boolean;
  readonly model: string | null;
  readonly p50Ms: number | null;
}

/** Sidebar label, e.g. `Decider · 2B-qwen3.5-v1-2610 · 120 ms` or `Decider · down`. */
export function statusLabel(
  status: StatusLike | undefined,
  shortModel: (m: string) => string,
): string {
  if (status === undefined) {
    return 'Decider · …';
  }
  if (!status.up) {
    return 'Decider · down';
  }
  const parts = ['Decider'];
  if (status.model !== null && status.model !== '') {
    parts.push(shortModel(status.model));
  }
  if (status.p50Ms !== null) {
    parts.push(`${Math.round(status.p50Ms)} ms`);
  }
  return parts.join(' · ');
}
