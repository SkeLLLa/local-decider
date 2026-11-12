import type { Scope } from '@ziptie-soft/local-decider-core';

import type { LogStore } from './log-store.ts';
import type { LoadedPolicy } from './policies.ts';
import type { Pricing } from './savings.ts';
import { computeStats, type PolicyStats } from './stats.ts';

/** Everything a stats computation needs; plain data, so it crosses a worker boundary. */
export interface StatsJob {
  readonly days: number;
  readonly scope?: Scope | undefined;
  readonly pricing?: Pricing | undefined;
  readonly policies?: ReadonlyMap<string, LoadedPolicy> | undefined;
}

const DEFAULT_STATS_DAYS = 30;

/** The windowed read plus aggregation, shared by the CLI, the in-process path and the worker. */
export function runStats(log: LogStore, job: StatsJob): PolicyStats[] {
  return computeStats(
    log.readRecent(job.days),
    job.pricing,
    job.policies,
    job.scope === undefined ? {} : { scope: job.scope },
  );
}

/** `?days=` / `--days`: an integer from 1 to the retention window; absent means the default. */
export function parseDays(
  raw: string | null | undefined,
  max: number,
): { readonly days: number } | { readonly error: string } {
  if (raw === null || raw === undefined) {
    return { days: Math.min(DEFAULT_STATS_DAYS, max) };
  }
  const days = /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
  return days >= 1 && days <= max
    ? { days }
    : { error: `days must be an integer from 1 to ${String(max)}` };
}
