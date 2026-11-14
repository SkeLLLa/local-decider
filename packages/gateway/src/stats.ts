import type {
  Answer,
  LogRecord,
  OutcomeRecord,
  Policy,
  PolicyRule,
  Scope,
  ShadowRecord,
  UsageRecord,
} from '@ziptie-soft/local-decider-core';

import { classifierAgreement, type ClassifierAgreement } from './classifier-agreement.ts';
import { ENGINE_BENCHMARK_RUNNING_ERROR } from './engine-busy.ts';
import { percentile, sortedLatencies, wilsonUpper } from './numbers.ts';
import {
  comparableOutcome,
  correctedOutcome,
  isVerifiedOutcome,
  outcomeClass,
} from './outcome-labels.ts';
import type { LoadedPolicy } from './policies.ts';
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
  /** Decisions with a reported outcome (`decline` and `interrupted` don't label the model's answer). */
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
  /** Advisory threshold suggestions from escalated allow-rule decisions. */
  readonly calibrationHints?: readonly CalibrationHint[];
  /** Decisions made for the Claude Code auto-mode scope, compared with the classifier's verdicts. */
  readonly classifierAgreement?: ClassifierAgreement;
  /** Unverified reports grouped by the caller's claimed source. */
  readonly unverifiedByClaimedSource?: Readonly<Record<string, number>>;
}

export interface CalibrationHint {
  readonly rule: string;
  readonly threshold?: number;
  readonly n: number;
  /** Deny or unsafe. */
  readonly denies: number;
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
  readonly unverified: readonly OutcomeRecord[];
  /** The effective verified outcome per decision (first wins; neutral may become a veto). */
  readonly verified: ReadonlyMap<string, string>;
  /** The latest outcome per decision that the auto-mode classifier reported. */
  readonly classifier: ReadonlyMap<string, OutcomeRecord>;
  readonly scope: Scope;
  readonly usage: ReadonlyMap<string, readonly UsageRecord[]>;
  readonly pricing: Pricing;
}

function extras(decisions: readonly ShadowRecord[], joined: Joined): Partial<PolicyStats> {
  const savings = computeSavings(decisions, joined.usage, joined.pricing);
  const promptTime = computePromptTime(decisions, joined.outcomes);
  return {
    ...(savings === undefined ? {} : { savings }),
    ...(promptTime === undefined ? {} : { promptTime }),
    ...agreementOf(decisions, joined),
  };
}

function agreementOf(
  decisions: readonly ShadowRecord[],
  joined: Joined,
): { classifierAgreement?: ClassifierAgreement } {
  const agreement = classifierAgreement(joined.scope, decisions, joined.classifier);
  return agreement === undefined ? {} : { classifierAgreement: agreement };
}

interface ThresholdSample {
  readonly probability: number;
  readonly denied: boolean;
}

function eligibleAllowRules(policy: Policy): PolicyRule[] {
  return policy.rules.filter(
    (rule) =>
      rule.action === 'allow' &&
      rule.when.precedent === undefined &&
      rule.when.minProbability !== undefined,
  );
}

function samplesForRule(
  rule: PolicyRule,
  decisions: readonly ShadowRecord[],
  verified: ReadonlyMap<string, string>,
): ThresholdSample[] {
  const samples: ThresholdSample[] = [];
  for (const decision of decisions) {
    const outcome = verified.get(decision.decisionId);
    const cls = outcome === undefined ? 'other' : outcomeClass(outcome);
    if (
      decision.error === ENGINE_BENCHMARK_RUNNING_ERROR ||
      decision.action !== 'ask' ||
      (cls !== 'allow' && cls !== 'veto')
    ) {
      continue;
    }
    const probability = decision.answers[rule.when.question]?.probabilities[rule.when.answer];
    if (
      probability !== undefined &&
      Number.isFinite(probability) &&
      probability >= 0 &&
      probability <= 1
    ) {
      samples.push({ probability, denied: cls === 'veto' });
    }
  }
  return samples.toSorted((a, b) => a.probability - b.probability);
}

function suggestedThreshold(
  samples: readonly ThresholdSample[],
): { threshold: number; n: number; denies: number } | undefined {
  let denies = samples.filter((sample) => sample.denied).length;
  for (let start = 0; start < samples.length;) {
    const threshold = samples[start]?.probability;
    if (threshold === undefined) {
      return undefined;
    }
    let end = start;
    let groupDenies = 0;
    while (end < samples.length && samples[end]?.probability === threshold) {
      groupDenies += Number(samples[end]?.denied ?? false);
      end += 1;
    }
    const n = samples.length - start;
    if (n >= 100 && wilsonUpper(denies, n) <= 0.02) {
      return { threshold, n, denies };
    }
    denies -= groupDenies;
    start = end;
  }
  return undefined;
}

function calibrationHints(
  policy: Policy | undefined,
  decisions: readonly ShadowRecord[],
  verified: ReadonlyMap<string, string>,
): CalibrationHint[] {
  if (policy === undefined) {
    return [];
  }
  return eligibleAllowRules(policy).map((rule) => {
    const samples = samplesForRule(rule, decisions, verified);
    const suggestion = suggestedThreshold(samples);
    const denies = samples.filter((sample) => sample.denied).length;
    return {
      rule: `${rule.when.question}.${rule.when.answer}`,
      ...(suggestion === undefined ? {} : { threshold: suggestion.threshold }),
      n: suggestion?.n ?? samples.length,
      denies: suggestion?.denies ?? denies,
    };
  });
}

function labelledDecisions(
  decisions: readonly ShadowRecord[],
  outcomes: ReadonlyMap<string, OutcomeRecord>,
): Labelled[] {
  const labelled: Labelled[] = [];
  for (const d of decisions) {
    if (d.error === ENGINE_BENCHMARK_RUNNING_ERROR) {
      continue;
    }
    const record = outcomes.get(d.decisionId);
    const value = record === undefined ? undefined : comparableOutcome(record.outcome);
    const answer = value === undefined ? undefined : labelledAnswer(d, value);
    if (value !== undefined && answer !== undefined) {
      labelled.push({ answer, outcome: value });
    }
  }
  return labelled;
}

function policyStats(
  policy: string,
  policyDefinition: Policy | undefined,
  decisions: readonly ShadowRecord[],
  joined: Joined,
): PolicyStats {
  const hints = calibrationHints(policyDefinition, decisions, joined.verified);
  const latencies = sortedLatencies(decisions);
  const labelled = labelledDecisions(decisions, joined.outcomes);
  const unverified = countUnverified(decisions, joined.unverified);
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
    ...(Object.keys(unverified).length === 0 ? {} : { unverifiedByClaimedSource: unverified }),
    ...(hints.length === 0 ? {} : { calibrationHints: hints }),
    ...extras(decisions, joined),
  };
}

function countUnverified(
  decisions: readonly ShadowRecord[],
  outcomes: readonly OutcomeRecord[],
): Record<string, number> {
  const ids = new Set(decisions.map((decision) => decision.decisionId));
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (!ids.has(outcome.decisionId)) continue;
    const source = outcome.claimedSource ?? 'unknown';
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

export interface StatsOptions {
  /** Only decisions made for this request scope. */
  readonly scope?: Scope;
}

const DEFAULT_SCOPE: Scope = 'claude-auto';

function noteOutcomeRecord(
  record: OutcomeRecord,
  outcomes: Map<string, OutcomeRecord>,
  classifier: Map<string, OutcomeRecord>,
  verified: Map<string, string>,
): void {
  outcomes.set(record.decisionId, record);
  if (record.source === 'classifier' || record.claimedSource === 'classifier') {
    classifier.set(record.decisionId, record);
  }
  if (isVerifiedOutcome(record)) {
    const next = correctedOutcome(verified.get(record.decisionId), record.outcome);
    if (next !== undefined) {
      verified.set(record.decisionId, next);
    }
  }
}

interface JoinedRecords {
  readonly outcomes: Map<string, OutcomeRecord>;
  readonly unverified: OutcomeRecord[];
  readonly classifier: Map<string, OutcomeRecord>;
  readonly verified: Map<string, string>;
  readonly usage: UsageRecord[];
  readonly byPolicy: Map<string, ShadowRecord[]>;
}

function joinRecords(records: readonly LogRecord[], options: StatsOptions): JoinedRecords {
  const outcomes = new Map<string, OutcomeRecord>();
  const unverified: OutcomeRecord[] = [];
  const classifier = new Map<string, OutcomeRecord>();
  const verified = new Map<string, string>();
  const usage: UsageRecord[] = [];
  const byPolicy = new Map<string, ShadowRecord[]>();
  for (const record of records) {
    if (record.kind === 'outcome') {
      noteOutcomeRecord(record, outcomes, classifier, verified);
      if (record.source === 'unverified') unverified.push(record);
    } else if (record.kind === 'usage') {
      usage.push(record);
    } else if (options.scope === undefined || record.scope === options.scope) {
      const list = byPolicy.get(record.policy) ?? [];
      list.push(record);
      byPolicy.set(record.policy, list);
    }
  }
  return { outcomes, unverified, classifier, verified, usage, byPolicy };
}

/**
 * Agreement, calibration and savings per policy from shadow-log records. The latest outcome
 * wins for agreement (`unsafe` compares as `deny`); calibration uses the effective verified
 * outcome. `pricing` (optional) adds dollar estimates to token savings.
 */
export function computeStats(
  records: readonly LogRecord[],
  pricing: Pricing = {},
  policies?: ReadonlyMap<string, LoadedPolicy>,
  options: StatsOptions = {},
): PolicyStats[] {
  const { outcomes, unverified, classifier, verified, usage, byPolicy } = joinRecords(
    records,
    options,
  );
  return [...byPolicy.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([policy, decisions]) =>
      policyStats(policy, policies?.get(policy)?.policy, decisions, {
        outcomes,
        unverified,
        verified,
        classifier,
        scope: options.scope ?? DEFAULT_SCOPE,
        usage: groupUsage(usage),
        pricing,
      }),
    );
}

function pct(x: number | undefined): string {
  return x === undefined ? '-' : `${(x * 100).toFixed(1)}%`;
}

function calibrationLine(hint: CalibrationHint): string {
  const recommendation =
    hint.threshold === undefined
      ? `not enough labelled escalations (n=${String(hint.n)}, denies=${String(hint.denies)})`
      : `suggest t=${hint.threshold.toFixed(2)} (n=${String(hint.n)}, denies=${String(hint.denies)})`;
  return `  allow threshold ${hint.rule} (advisory; not applied): ${recommendation}`;
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
    if (s.unverifiedByClaimedSource !== undefined) {
      lines.push(
        `  unverified outcomes ${Object.entries(s.unverifiedByClaimedSource)
          .map(([source, count]) => `${source}=${String(count)}`)
          .join(' ')}`,
      );
    }
    for (const b of s.reliability) {
      lines.push(
        `    conf ${b.range}: n=${String(b.n)} mean conf ${b.meanConfidence.toFixed(2)} accuracy ${pct(b.accuracy)}`,
      );
    }
    for (const hint of s.calibrationHints ?? []) {
      lines.push(calibrationLine(hint));
    }
    lines.push(...savingsLines(s), ...agreementLines(s.classifierAgreement));
  }
  return lines.join('\n');
}

function agreementLines(a: ClassifierAgreement | undefined): string[] {
  if (a === undefined) {
    return [];
  }
  const lower =
    a.allowPrecisionLower === undefined ? '' : `, Wilson 95% lower ${pct(a.allowPrecisionLower)}`;
  return [
    `  classifier agreement (${a.scope}): ${String(a.decisions)} decisions, ${String(a.n)} compared, coverage ${pct(a.coverage)}`,
    `    allow precision ${pct(a.allowPrecision)}${lower} (${String(a.bothAllowed)}/${String(a.wouldAllow)} would-allow calls the classifier allowed)`,
    `    decider ask-rate on classifier-allowed ${pct(a.askRateOnClassifierAllowed)} (n=${String(a.classifierAllowed)})`,
    `    latency p50 ${a.latencyP50Ms?.toFixed(0) ?? '-'} ms, p95 ${a.latencyP95Ms?.toFixed(0) ?? '-'} ms, ${String(a.errors)} timeouts or errors`,
    ...(a.disagreements.length === 0
      ? []
      : [`    disagreements (decider allow, classifier deny): ${a.disagreements.join(' ')}`]),
  ];
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
