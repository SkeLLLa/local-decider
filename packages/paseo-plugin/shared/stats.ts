/** `GET /v1/stats` per-policy summaries, read tolerantly for the stats screen. */
import { z } from 'zod';

const num = z.number().finite().nullable().catch(null);

export const policyStatsSchema = z.object({
  policy: z.string().max(100),
  decisions: z.number().int().nonnegative().catch(0),
  errors: z.number().int().nonnegative().catch(0),
  enforced: z.number().int().nonnegative().catch(0),
  labelled: z.number().int().nonnegative().catch(0),
  agreement: num.default(null),
  brier: num.default(null),
  latencyP50Ms: num.default(null),
  latencyP95Ms: num.default(null),
  actions: z.record(z.string().max(100), z.number()).catch({}),
});

export type PolicyStats = z.output<typeof policyStatsSchema>;

const MAX_POLICIES = 50;

/** Valid entries of a `/v1/stats` array; anything else yields []. */
export function parsePolicyStats(body: unknown): PolicyStats[] {
  if (!Array.isArray(body)) {
    return [];
  }
  const out: PolicyStats[] = [];
  for (const entry of body.slice(0, MAX_POLICIES)) {
    const parsed = policyStatsSchema.safeParse(entry);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

/** `notify 1 · log 10`, most frequent first. */
export function actionSummary(actions: Readonly<Record<string, number>>): string {
  return Object.entries(actions)
    .toSorted(([, a], [, b]) => b - a)
    .map(([action, n]) => `${action} ${String(n)}`)
    .join(' · ');
}

/** `850 ms` or `2.6 s`. */
export function formatMs(ms: number | null): string {
  if (ms === null) {
    return '—';
  }
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatPercent(x: number | null): string {
  return x === null ? '—' : `${(x * 100).toFixed(0)}%`;
}
