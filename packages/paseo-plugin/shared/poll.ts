import type { SidebarLabel } from './constants.ts';
import { engineTag } from './engines.ts';
import { compactModel, shortModel } from './models.ts';

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
  readonly status?: 'ok' | 'degraded' | 'down';
  readonly engine?: string | null;
  readonly model: string | null;
  readonly p50Ms: number | null;
}

/** Longest sidebar label before it is cut with an ellipsis; the host row wraps otherwise. */
const MAX_LABEL = 22;

/** `850ms`, `7.8s`, `12s`: latency in as few characters as possible. */
export function compactMs(ms: number): string {
  if (ms < 1000) {
    return `${String(Math.round(ms))}ms`;
  }
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${String(Math.round(ms / 1000))}s`;
}

/** Cut `text` to `max` characters, ending with an ellipsis when it was longer. */
export function ellipsis(text: string, max: number = MAX_LABEL): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Sidebar label, e.g. `qwen3.5 2B · 7.8s`, `Loading…` or `Offline`. The row's scale icon names
 * the plugin, so the label spends its space on details; `style` picks which. `minimal` shows
 * `Decider` while healthy.
 */
export function statusLabel(status: StatusLike | undefined, style: SidebarLabel = 'full'): string {
  if (status === undefined) {
    return 'Decider…';
  }
  if (!status.up) {
    return 'Offline';
  }
  if (status.status === 'degraded') {
    return 'Loading…';
  }
  const { model, tag, latency } = labelParts(status, style);
  const parts = [model, tag, latency].filter((p): p is string => p !== null);
  const label = parts.join(' · ');
  // The engine goes first when the label would not fit.
  if (tag !== null && label.length > MAX_LABEL) {
    return ellipsis([model, latency].filter((p): p is string => p !== null).join(' · '));
  }
  return parts.length === 0 ? 'Decider' : ellipsis(label);
}

function labelParts(
  status: StatusLike,
  style: SidebarLabel,
): { model: string | null; tag: string | null; latency: string | null } {
  const withModel = style === 'full' || style === 'model';
  const withLatency = style === 'full' || style === 'latency';
  const hasModel = status.model !== null && status.model !== '';
  return {
    model: withModel && hasModel ? compactModel(status.model) : null,
    tag: withModel ? engineTag(status.engine ?? null) : null,
    latency: withLatency && status.p50Ms !== null ? compactMs(status.p50Ms) : null,
  };
}

export interface StatusSummaryLike extends StatusLike {
  readonly engineState: string | null;
  readonly detail: string | null;
  readonly gatewayUrl: string;
}

/** One line for the settings screen: state, model, latency, and why it is not ready. */
export function statusSummary(status: StatusSummaryLike | undefined): string {
  if (status === undefined) {
    return 'Checking…';
  }
  if (!status.up) {
    return `Unreachable at ${status.gatewayUrl}. Start it with \`local-decider gateway start\` on the daemon machine.`;
  }
  const parts = [status.engineState ?? status.status ?? 'ok'];
  if (status.model !== null && status.model !== '') {
    parts.push(shortModel(status.model));
  }
  if (status.p50Ms !== null) {
    parts.push(`p50 ${Math.round(status.p50Ms)} ms`);
  }
  if (status.detail !== null) {
    parts.push(status.detail);
  }
  return parts.join(' · ');
}

/** `just now`, `42 s ago`, `5 min ago`; '—' for a missing or bad timestamp. */
export function checkedAgo(iso: string | undefined, now: number): string {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(at)) {
    return '—';
  }
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) {
    return 'just now';
  }
  return seconds < 120 ? `${String(seconds)} s ago` : `${String(Math.round(seconds / 60))} min ago`;
}
