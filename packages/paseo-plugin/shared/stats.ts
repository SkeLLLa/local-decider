/** `GET /v1/stats` per-policy summaries, read tolerantly for the stats screen. */
import { z } from 'zod';

const num = z.number().finite().nullable().catch(null);

const count = z.number().nonnegative().catch(0);

const totalsSchema = z.object({
  tasks: count,
  moved: count,
  tokens: z.object({ input: count, cachedInput: count, output: count }).catch({
    input: 0,
    cachedInput: 0,
    output: 0,
  }),
  savedUsd: num.default(null),
  unpricedMoves: count,
});

export type SavingsTotals = z.output<typeof totalsSchema>;

const savingsSchema = z
  .object({ potential: totalsSchema, realized: totalsSchema })
  .nullable()
  .catch(null);

const promptTimeSchema = z
  .object({ answered: count, userAllowed: count, waitTotalMs: count })
  .nullable()
  .catch(null);

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
  savings: savingsSchema.default(null),
  promptTime: promptTimeSchema.default(null),
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

/** `1.2M`, `34.5k` or `812`. */
function formatTokens(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(1)}M`;
  }
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
}

/** `3.3M tokens on another model · ~$18.40` for one side of a savings report; '' when empty. */
export function savingsSummary(t: SavingsTotals): string {
  if (t.moved === 0) {
    return '';
  }
  const tokens = formatTokens(t.tokens.input + t.tokens.cachedInput + t.tokens.output);
  const parts = [
    `${String(t.moved)}/${String(t.tasks)} tasks`,
    `${tokens} tokens on another model`,
  ];
  if (t.savedUsd !== null) {
    const sign = t.savedUsd < 0 ? '−' : '';
    parts.push(`~${sign}$${Math.abs(t.savedUsd).toFixed(2)}`);
  }
  return parts.join(' · ');
}

/** `12 prompts · 3.4 min` you answered that the policy would have allowed; '' when none. */
export function promptTimeSummary(p: { answered: number; waitTotalMs: number } | null): string {
  if (p === null || p.answered === 0) {
    return '';
  }
  const minutes = p.waitTotalMs / 60_000;
  const time =
    minutes < 1 ? `${String(Math.round(p.waitTotalMs / 1000))} s` : `${minutes.toFixed(1)} min`;
  return `${String(p.answered)} prompts · ${time}`;
}
