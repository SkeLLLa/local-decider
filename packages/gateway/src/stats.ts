import type {
  Answer,
  LogRecord,
  OutcomeRecord,
  ShadowRecord,
  UsageRecord,
} from '@local-decider/core';

import {
  computePromptTime,
  computeSavings,
  groupUsage,
  type Pricing,
  type PromptTime,
  type Savings,
  type SavingsTotals,
} from './savings.ts';

const BUCKETS = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1.000_001] as const;

export interface Bucket {
  readonly range: string;
  readonly n: number;
  readonly meanConfidence: number;
  readonly accuracy: number;
}

export interface PolicyStats {
  readonly policy: string;
  readonly decisions: number;
  readonly errors: number;
  readonly enforced: number;
  readonly actions: Readonly<Record<string, number>>;
  readonly latencyP50Ms?: number;
  readonly latencyP95Ms?: number;
  /** Decisions with a reported outcome. */
  readonly labelled: number;
  /** Share of labelled decisions whose predicted answer matched the outcome. */
  readonly agreement?: number;
  /** Mean multi-class Brier score over labelled decisions (0 = perfect, 2 = worst). */
  readonly brier?: number;
  readonly reliability: readonly Bucket[];
  /** Routing policies: tokens moved between models, priced when a price table is configured. */
  readonly savings?: Savings;
  /** Policies that allow: time spent on prompts they would have answered. */
  readonly promptTime?: PromptTime;
}

function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** The answer an outcome labels: the first answer whose option space contains the outcome. */
function labelledAnswer(record: ShadowRecord, outcome: string): Answer | undefined {
  return Object.values(record.answers).find((answer) => outcome in answer.probabilities);
}

function brier(answer: Answer, outcome: string): number {
  return Object.entries(answer.probabilities).reduce(
    (acc, [option, p]) => acc + (p - (option === outcome ? 1 : 0)) ** 2,
    0,
  );
}

interface Labelled {
  readonly answer: Answer;
  readonly outcome: string;
}

function reliability(labelled: readonly Labelled[]): Bucket[] {
  const out: Bucket[] = [];
  for (let i = 0; i < BUCKETS.length - 1; i++) {
    const lo = BUCKETS[i] ?? 0;
    const hi = BUCKETS[i + 1] ?? 1;
    const inBucket = labelled.filter((l) => l.answer.confidence >= lo && l.answer.confidence < hi);
    if (inBucket.length === 0) {
      continue;
    }
    const correct = inBucket.filter((l) => l.answer.answer === l.outcome).length;
    const meanConfidence =
      inBucket.reduce((acc, l) => acc + l.answer.confidence, 0) / inBucket.length;
    out.push({
      range: `${lo.toFixed(2)}-${Math.min(hi, 1).toFixed(2)}`,
      n: inBucket.length,
      meanConfidence,
      accuracy: correct / inBucket.length,
    });
  }
  return out;
}

function countActions(decisions: readonly ShadowRecord[]): Record<string, number> {
  const actions: Record<string, number> = {};
  for (const d of decisions) {
    actions[d.action] = (actions[d.action] ?? 0) + 1;
  }
  return actions;
}

interface Joined {
  readonly outcomes: ReadonlyMap<string, OutcomeRecord>;
  readonly usage: ReadonlyMap<string, readonly UsageRecord[]>;
  readonly pricing: Pricing;
}

function extras(decisions: readonly ShadowRecord[], joined: Joined): Partial<PolicyStats> {
  const savings = computeSavings(decisions, joined.usage, joined.pricing);
  const promptTime = computePromptTime(decisions, joined.outcomes);
  return {
    ...(savings === undefined ? {} : { savings }),
    ...(promptTime === undefined ? {} : { promptTime }),
  };
}

function policyStats(
  policy: string,
  decisions: readonly ShadowRecord[],
  joined: Joined,
): PolicyStats {
  const { outcomes } = joined;
  const latencies = decisions
    .filter((d) => d.error === undefined)
    .map((d) => d.latencyMs)
    .toSorted((a, b) => a - b);
  const labelled: Labelled[] = [];
  for (const d of decisions) {
    const outcome = outcomes.get(d.decisionId);
    const answer = outcome === undefined ? undefined : labelledAnswer(d, outcome.outcome);
    if (outcome !== undefined && answer !== undefined) {
      labelled.push({ answer, outcome: outcome.outcome });
    }
  }
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  return {
    policy,
    decisions: decisions.length,
    errors: decisions.filter((d) => d.error !== undefined).length,
    enforced: decisions.filter((d) => d.enforced).length,
    actions: countActions(decisions),
    ...(p50 === undefined ? {} : { latencyP50Ms: p50 }),
    ...(p95 === undefined ? {} : { latencyP95Ms: p95 }),
    labelled: labelled.length,
    ...(labelled.length === 0
      ? {}
      : {
          agreement: labelled.filter((l) => l.answer.answer === l.outcome).length / labelled.length,
          brier: labelled.reduce((acc, l) => acc + brier(l.answer, l.outcome), 0) / labelled.length,
        }),
    reliability: reliability(labelled),
    ...extras(decisions, joined),
  };
}

/**
 * Agreement, calibration and savings per policy from shadow-log records. The latest outcome
 * wins; `pricing` (optional) adds dollar estimates to token savings.
 */
export function computeStats(records: readonly LogRecord[], pricing: Pricing = {}): PolicyStats[] {
  const outcomes = new Map<string, OutcomeRecord>();
  const usage: UsageRecord[] = [];
  const byPolicy = new Map<string, ShadowRecord[]>();
  for (const record of records) {
    if (record.kind === 'outcome') {
      outcomes.set(record.decisionId, record);
    } else if (record.kind === 'usage') {
      usage.push(record);
    } else {
      const list = byPolicy.get(record.policy) ?? [];
      list.push(record);
      byPolicy.set(record.policy, list);
    }
  }
  return [...byPolicy.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([policy, decisions]) =>
      policyStats(policy, decisions, { outcomes, usage: groupUsage(usage), pricing }),
    );
}

function pct(x: number | undefined): string {
  return x === undefined ? '-' : `${(x * 100).toFixed(1)}%`;
}

/** Plain-text report for `local-decider stats`. */
export function formatStats(stats: readonly PolicyStats[]): string {
  if (stats.length === 0) {
    return 'No decisions logged yet.';
  }
  const lines: string[] = [];
  for (const s of stats) {
    lines.push(
      `${s.policy}: ${String(s.decisions)} decisions, ${String(s.errors)} errors, ${String(s.enforced)} enforced`,
      `  latency p50 ${s.latencyP50Ms?.toFixed(0) ?? '-'} ms, p95 ${s.latencyP95Ms?.toFixed(0) ?? '-'} ms`,
      `  actions ${Object.entries(s.actions)
        .map(([a, n]) => `${a}=${String(n)}`)
        .join(' ')}`,
      `  labelled ${String(s.labelled)}, agreement ${pct(s.agreement)}, brier ${s.brier?.toFixed(3) ?? '-'}`,
    );
    for (const b of s.reliability) {
      lines.push(
        `    conf ${b.range}: n=${String(b.n)} mean conf ${b.meanConfidence.toFixed(2)} accuracy ${pct(b.accuracy)}`,
      );
    }
    lines.push(...savingsLines(s));
  }
  return lines.join('\n');
}

function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

function usd(x: number): string {
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
}

function totalsLine(label: string, t: SavingsTotals): string[] {
  if (t.tasks === 0) {
    return [];
  }
  const moved = t.tokens.input + t.tokens.cachedInput + t.tokens.output;
  const money =
    t.savedUsd === undefined
      ? ''
      : `, ${usd(t.savedUsd)} saved${t.unpricedMoves > 0 ? ` (${String(t.unpricedMoves)} model pairs unpriced)` : ''}`;
  return [
    `  ${label}: ${String(t.moved)}/${String(t.tasks)} tasks on another model, ${tokens(moved)} tokens${money}`,
    ...t.moves.map(
      (m) =>
        `    ${m.from} → ${m.to}: ${String(m.tasks)} tasks${m.savedUsd === undefined ? '' : `, ${usd(m.savedUsd)}`}`,
    ),
  ];
}

function savingsLines(s: PolicyStats): string[] {
  const lines: string[] = [];
  if (s.savings !== undefined) {
    lines.push(
      ...totalsLine('potential (shadow, upper bound)', s.savings.potential),
      ...totalsLine('realized', s.savings.realized),
    );
  }
  const p = s.promptTime;
  if (p !== undefined) {
    lines.push(
      `  would-allow prompts you answered: ${String(p.answered)} (${String(p.userAllowed)} allowed), ${(p.waitTotalMs / 1000).toFixed(0)} s total, p50 ${((p.waitP50Ms ?? 0) / 1000).toFixed(1)} s`,
    );
  }
  return lines;
}
