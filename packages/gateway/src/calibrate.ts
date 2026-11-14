import type {
  Answer,
  LogRecord,
  Policy,
  PolicyRule,
  ShadowRecord,
} from '@ziptie-soft/local-decider-core';

import { correctedOutcome, isVerifiedOutcome } from './outcome-labels.ts';
import type { Paths } from './paths.ts';
import type { LoadedPolicy } from './policies.ts';
import { openLogStore } from './sqlite-log.ts';

const MIN_SAMPLES = 50;
const MIN_THRESHOLD_SAMPLES = 30;
const TARGET_ALLOW_PRECISION = 0.98;
const WILSON_Z_95 = 1.959963984540054;
const TEMP_MIN = 0.25;
const TEMP_MAX = 4;
const TEMP_STEP = 0.005;
const ECE_BINS = 10;

export interface CalibrationMetrics {
  readonly brier: number;
  readonly ece: number;
}

export interface SuggestedAllowThreshold {
  readonly rule: string;
  readonly threshold: number;
  readonly precision: number;
  readonly n: number;
}

export interface CalibrationResult {
  readonly policy: string;
  readonly engine: string;
  readonly model: string;
  readonly n: number;
  readonly status: 'insufficient-data' | 'calibrated';
  readonly temperature?: number;
  readonly before?: CalibrationMetrics;
  readonly after?: CalibrationMetrics;
  readonly suggestedAllowThresholds?: readonly SuggestedAllowThreshold[];
}

interface Sample {
  readonly question: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly outcome: string;
}

interface Group {
  readonly policy: string;
  readonly engine: string;
  readonly model: string;
  readonly samples: Sample[];
}

/** Read-only calibration report from all retained SQLite records. */
export function calibrateFromFile(
  paths: Paths,
  policies: ReadonlyMap<string, LoadedPolicy>,
): CalibrationResult[] {
  let log: ReturnType<typeof openLogStore>;
  try {
    log = openLogStore(paths, { readOnly: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  try {
    return calibrate(log.read(), policies);
  } finally {
    log.close();
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** Fit one report per policy, engine and model, using effective verified labels only. */
export function calibrate(
  records: readonly LogRecord[],
  policies: ReadonlyMap<string, LoadedPolicy>,
): CalibrationResult[] {
  const labels = effectiveOutcomes(records);
  const groups = sampleGroups(records, labels);
  return [...groups.values()]
    .toSorted((a, b) => groupOrder(a).localeCompare(groupOrder(b)))
    .map((group) => resultFor(group, policies.get(group.policy)?.policy));
}

function effectiveOutcomes(records: readonly LogRecord[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== 'outcome' || !isVerifiedOutcome(record)) continue;
    const next = correctedOutcome(labels.get(record.decisionId), record.outcome);
    if (next !== undefined) labels.set(record.decisionId, next);
  }
  return labels;
}

function sampleGroups(
  records: readonly LogRecord[],
  labels: ReadonlyMap<string, string>,
): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const record of records) {
    if (record.kind !== 'decision') continue;
    const outcome = labels.get(record.decisionId);
    const sample = outcome === undefined ? undefined : sampleFor(record, outcome);
    if (sample === undefined) continue;
    const policy = record.variant ?? record.policy;
    const key = JSON.stringify([policy, record.engine, record.model]);
    const group = groups.get(key) ?? {
      policy,
      engine: record.engine,
      model: record.model,
      samples: [],
    };
    group.samples.push(sample);
    groups.set(key, group);
  }
  return groups;
}

function sampleFor(record: ShadowRecord, outcome: string): Sample | undefined {
  for (const [question, answer] of Object.entries(record.answers)) {
    const probabilities = normalizedProbabilities(answer);
    if (probabilities !== undefined && Object.hasOwn(probabilities, outcome)) {
      return { question, probabilities, outcome };
    }
  }
  return undefined;
}

function normalizedProbabilities(answer: Answer): Record<string, number> | undefined {
  const entries = Object.entries(answer.probabilities);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (
    entries.length === 0 ||
    entries.some(([, value]) => !Number.isFinite(value) || value < 0) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return undefined;
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value / total]));
}

function resultFor(group: Group, policy: Policy | undefined): CalibrationResult {
  const n = group.samples.length;
  if (n < MIN_SAMPLES) {
    return {
      policy: group.policy,
      engine: group.engine,
      model: group.model,
      n,
      status: 'insufficient-data',
    };
  }
  const temperature = fitTemperature(group.samples);
  return {
    policy: group.policy,
    engine: group.engine,
    model: group.model,
    n,
    status: 'calibrated',
    temperature,
    before: metrics(group.samples, 1),
    after: metrics(group.samples, temperature),
    ...thresholdSuggestions(group.samples, policy),
  };
}

function groupOrder(group: Group): string {
  return `${group.policy}\0${group.engine}\0${group.model}`;
}

function fitTemperature(samples: readonly Sample[]): number {
  let best = TEMP_MIN;
  let bestLoss = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= Math.round((TEMP_MAX - TEMP_MIN) / TEMP_STEP); i += 1) {
    const temperature = TEMP_MIN + i * TEMP_STEP;
    const loss = nll(samples, temperature);
    if (loss < bestLoss) {
      best = temperature;
      bestLoss = loss;
    }
  }
  return Number(best.toFixed(3));
}

function nll(samples: readonly Sample[], temperature: number): number {
  return (
    samples.reduce(
      (sum, sample) =>
        sum -
        Math.log(temperatureProbabilities(sample.probabilities, temperature)[sample.outcome] ?? 0),
      0,
    ) / samples.length
  );
}

function temperatureProbabilities(
  probabilities: Readonly<Record<string, number>>,
  temperature: number,
): Record<string, number> {
  const powered = Object.entries(probabilities).map(
    ([key, probability]) =>
      [key, probability === 0 ? 0 : probability ** (1 / temperature)] as const,
  );
  const sum = powered.reduce((total, [, probability]) => total + probability, 0);
  return Object.fromEntries(powered.map(([key, probability]) => [key, probability / sum]));
}

function metrics(samples: readonly Sample[], temperature: number): CalibrationMetrics {
  const calibrated = samples.map((sample) => ({
    sample,
    probabilities: temperatureProbabilities(sample.probabilities, temperature),
  }));
  const brier = calibrated.reduce((sum, item) => {
    const score = Object.entries(item.probabilities).reduce(
      (total, [answer, probability]) =>
        total + (probability - Number(answer === item.sample.outcome)) ** 2,
      0,
    );
    return sum + score;
  }, 0);
  return { brier: brier / samples.length, ece: expectedCalibrationError(calibrated) };
}

function expectedCalibrationError(
  rows: readonly { sample: Sample; probabilities: Readonly<Record<string, number>> }[],
): number {
  let error = 0;
  for (let bin = 0; bin < ECE_BINS; bin += 1) {
    const low = bin / ECE_BINS;
    const high = (bin + 1) / ECE_BINS;
    const items = rows.flatMap((row) => {
      const best = Object.entries(row.probabilities).toSorted((a, b) => b[1] - a[1])[0];
      if (best === undefined || best[1] < low || (bin < ECE_BINS - 1 && best[1] >= high)) {
        return [];
      }
      return [{ confidence: best[1], correct: best[0] === row.sample.outcome }];
    });
    if (items.length === 0) continue;
    const confidence = items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
    const accuracy = items.filter((item) => item.correct).length / items.length;
    error += (items.length / rows.length) * Math.abs(accuracy - confidence);
  }
  return error;
}

function thresholdSuggestions(
  samples: readonly Sample[],
  policy: Policy | undefined,
): Pick<CalibrationResult, 'suggestedAllowThresholds'> {
  if (policy === undefined) return {};
  const allowRules = policy.rules.filter(
    (rule) => rule.action === 'allow' && rule.when.minProbability !== undefined,
  );
  if (allowRules.length === 0) return {};
  const floor = Math.min(...allowRules.map((rule) => rule.when.minProbability ?? 1));
  const suggestions = allowRules.flatMap((rule) => thresholdForRule(rule, samples, floor) ?? []);
  return suggestions.length === 0 ? {} : { suggestedAllowThresholds: suggestions };
}

function thresholdForRule(
  rule: PolicyRule,
  samples: readonly Sample[],
  floor: number,
): SuggestedAllowThreshold[] | undefined {
  const answer = rule.when.answer;
  const values = samples.flatMap((sample) => {
    const probability = sample.probabilities[answer];
    return sample.question === rule.when.question && probability !== undefined
      ? [{ probability, allowed: sample.outcome === answer }]
      : [];
  });
  if (values.length < MIN_SAMPLES) return undefined;
  const candidates = [...new Set([floor, ...values.map((value) => value.probability)])]
    .filter((value) => value >= floor)
    .toSorted((a, b) => a - b);
  for (const threshold of candidates) {
    const selected = values.filter((value) => value.probability >= threshold);
    if (selected.length < MIN_THRESHOLD_SAMPLES) continue;
    const allowed = selected.filter((value) => value.allowed).length;
    const precision = allowed / selected.length;
    if (wilsonLowerBound(allowed, selected.length) >= TARGET_ALLOW_PRECISION) {
      return [
        {
          rule: `${rule.when.question}.${answer}`,
          threshold,
          precision,
          n: selected.length,
        },
      ];
    }
  }
  return undefined;
}

function wilsonLowerBound(successes: number, total: number): number {
  const zSquared = WILSON_Z_95 ** 2;
  const precision = successes / total;
  const denominator = 1 + zSquared / total;
  const center = precision + zSquared / (2 * total);
  const margin =
    WILSON_Z_95 * Math.sqrt((precision * (1 - precision)) / total + zSquared / (4 * total ** 2));
  return (center - margin) / denominator;
}

/** Human-readable output for `local-decider calibrate`. */
export function formatCalibration(results: readonly CalibrationResult[]): string {
  if (results.length === 0) return 'No verified calibration data logged yet.';
  return results.flatMap(formatResult).join('\n');
}

function formatResult(result: CalibrationResult): string[] {
  const title = `${result.policy} (${result.engine}/${result.model}): n=${String(result.n)}`;
  if (result.status === 'insufficient-data') {
    return [`${title}, insufficient data (need ${String(MIN_SAMPLES)})`];
  }
  const lines = [
    `${title}, T=${result.temperature?.toFixed(3) ?? '-'}`,
    `  Brier ${result.before?.brier.toFixed(4) ?? '-'} → ${result.after?.brier.toFixed(4) ?? '-'}, ECE ${result.before?.ece.toFixed(4) ?? '-'} → ${result.after?.ece.toFixed(4) ?? '-'}`,
  ];
  for (const suggestion of result.suggestedAllowThresholds ?? []) {
    lines.push(
      `  allow ${suggestion.rule}: minProbability ${suggestion.threshold.toFixed(3)} ` +
        `(precision=${suggestion.precision.toFixed(3)}, n=${String(suggestion.n)})`,
    );
  }
  return lines;
}
