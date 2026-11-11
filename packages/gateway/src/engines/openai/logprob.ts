import type { Question, WireAnswer } from '@local-decider/core';

const SYSTEM_PROMPT =
  'You are a precise classifier. Read the state, then answer with exactly one option label and nothing else.';
const DEFAULT_MAX_OPTIONS = 10;
const DEFAULT_MIN_COVERAGE = 0.5;
const DEFAULT_TEMPERATURE = 1;

export interface PromptLabel {
  readonly label: string;
  readonly key: string;
}

export interface RenderedPrompt {
  readonly system: string;
  readonly user: string;
  readonly prompt: string;
  readonly labels: readonly PromptLabel[];
}

export interface TopLogprob {
  readonly token: string;
  readonly logprob: number;
}

export interface OptionMasses {
  /** Valid option-token mass before adding floors or normalising. */
  readonly coverage: number;
  /** Coverage threshold that decides whether a wire answer can be returned. */
  readonly minCoverage: number;
  /** Normalised probability per systemone answer key. */
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface OptionMassOptions {
  readonly maxOptions?: number;
  readonly minCoverage?: number;
  readonly temperature?: number;
}

function labelsFor(question: Question): PromptLabel[] {
  if (question.type === 'noul') {
    return [
      { label: 'yes', key: 'true' },
      { label: 'no', key: 'false' },
    ];
  }
  if (question.type === 'choice') {
    return Object.keys(question.criteria).map((key, index) => ({
      label: String.fromCharCode(65 + index),
      key,
    }));
  }
  return question.criteria.map((_, index) => ({ label: String(index), key: String(index) }));
}

function tailFor(question: Question, labels: readonly PromptLabel[]): string {
  if (question.type === 'noul') {
    return [
      'Options:',
      `yes: ${question.criteria?.true ?? 'it is true'}`,
      `no: ${question.criteria?.false ?? 'it is false'}`,
      'Answer yes or no.',
    ].join('\n');
  }
  if (question.type === 'choice') {
    const choices = labels.map(
      ({ label, key }) => `${label}. ${key}: ${question.criteria[key] ?? ''}`,
    );
    const last = labels.at(-1)?.label ?? 'A';
    return [...choices, `Answer with one letter (A–${last}).`].join('\n');
  }
  const levels = labels.map(({ label }) => `${label}: ${question.criteria[Number(label)] ?? ''}`);
  const last = labels.at(-1)?.label ?? '0';
  return [...levels, `Answer with one digit (0–${last}).`].join('\n');
}

export function renderPrompt(question: Question, state: string): RenderedPrompt {
  const labels = labelsFor(question);
  const user = `<state>\n${state}\n</state>\n\nQuestion: ${question.instructions}\n${tailFor(question, labels)}`;
  return {
    system: SYSTEM_PROMPT,
    user,
    prompt: `${SYSTEM_PROMPT}\n\n${user}\nAnswer:`,
    labels,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function parseEntryArray(value: unknown): TopLogprob[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: TopLogprob[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (typeof row?.['token'] === 'string' && typeof row['logprob'] === 'number') {
      entries.push({ token: row['token'], logprob: row['logprob'] });
    }
  }
  return entries;
}

function parseCompletionMap(value: unknown): TopLogprob[] {
  const map = asRecord(value);
  if (map === undefined) {
    return [];
  }
  return Object.entries(map)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([token, logprob]) => ({ token, logprob }));
}

function parseLogprobs(logprobs: Record<string, unknown>): TopLogprob[] {
  const content = asRecord(first(logprobs['content']));
  if (content !== undefined) {
    return parseEntryArray(content['top_logprobs']);
  }
  const position = first(logprobs['top_logprobs']);
  return Array.isArray(position) ? parseEntryArray(position) : parseCompletionMap(position);
}

/** Read top-token probabilities from chat-completions or legacy completions responses. */
export function parseTopLogprobs(response: unknown): TopLogprob[] {
  const root = asRecord(response);
  const choice = asRecord(first(root?.['choices']));
  const logprobs = asRecord(choice?.['logprobs']);
  return logprobs === undefined ? [] : parseLogprobs(logprobs);
}

function canonicalToken(token: string): string {
  const cleaned = token
    .trim()
    .replace(/^\(+/, '')
    .replace(/[.):]+$/, '')
    .trim();
  const lower = cleaned.toLowerCase();
  if (['yes', 'y', 'true'].includes(lower)) {
    return 'yes';
  }
  if (['no', 'n', 'false'].includes(lower)) {
    return 'no';
  }
  return /^[a-z]$/i.test(cleaned) ? cleaned.toUpperCase() : cleaned;
}

function keyForToken(
  question: Question,
  options: readonly PromptLabel[],
  token: string,
): string | undefined {
  const canonical = canonicalToken(token);
  const matched = options.find((option) => option.label === canonical);
  if (matched !== undefined) {
    return matched.key;
  }
  if (question.type === 'noul' && canonical === 'yes') {
    return 'true';
  }
  return question.type === 'noul' && canonical === 'no' ? 'false' : undefined;
}

function validMassOptions(options: OptionMassOptions): boolean {
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const maxOptions = options.maxOptions ?? DEFAULT_MAX_OPTIONS;
  return (
    Number.isFinite(temperature) &&
    temperature > 0 &&
    Number.isFinite(minCoverage) &&
    minCoverage >= 0 &&
    minCoverage <= 1 &&
    Number.isInteger(maxOptions) &&
    maxOptions >= 0
  );
}

function tokenMasses(
  question: Question,
  labels: readonly PromptLabel[],
  entries: readonly TopLogprob[],
): { readonly found: ReadonlyMap<string, number>; readonly floor: number } | undefined {
  const found = new Map(labels.map(({ key }) => [key, 0]));
  let minLogprob = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (!Number.isFinite(entry.logprob)) {
      continue;
    }
    const probability = Math.exp(entry.logprob);
    if (!Number.isFinite(probability) || probability <= 0) {
      continue;
    }
    minLogprob = Math.min(minLogprob, entry.logprob);
    const key = keyForToken(question, labels, entry.token);
    if (key !== undefined) {
      found.set(key, (found.get(key) ?? 0) + probability);
    }
  }
  return Number.isFinite(minLogprob) ? { found, floor: Math.exp(minLogprob) } : undefined;
}

function normalizedProbabilities(
  labels: readonly PromptLabel[],
  found: ReadonlyMap<string, number>,
  floor: number,
  temperature: number,
): Readonly<Record<string, number>> | undefined {
  const weights = labels.map(
    ({ key }) => Math.max(found.get(key) ?? 0, floor) ** (1 / temperature),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return total > 0 && Number.isFinite(total)
    ? Object.fromEntries(labels.map(({ key }, index) => [key, (weights[index] ?? 0) / total]))
    : undefined;
}

/** Aggregate token variants, apply the missing-label floor, and temperature-normalise. */
export function optionMasses(
  question: Question,
  entries: readonly TopLogprob[],
  options: OptionMassOptions = {},
): OptionMasses | undefined {
  if (!validMassOptions(options)) {
    return undefined;
  }
  const labels = labelsFor(question);
  if (labels.length > (options.maxOptions ?? DEFAULT_MAX_OPTIONS)) {
    return undefined;
  }
  const tokenData = tokenMasses(question, labels, entries);
  if (tokenData === undefined) {
    return undefined;
  }
  const coverage = [...tokenData.found.values()].reduce((sum, mass) => sum + mass, 0);
  const probabilities = normalizedProbabilities(
    labels,
    tokenData.found,
    tokenData.floor,
    options.temperature ?? DEFAULT_TEMPERATURE,
  );
  return probabilities === undefined
    ? undefined
    : { coverage, minCoverage: options.minCoverage ?? DEFAULT_MIN_COVERAGE, probabilities };
}

function argmaxKey(
  keys: readonly string[],
  probabilities: Readonly<Record<string, number>>,
): string {
  let best = keys[0] ?? '';
  for (const key of keys.slice(1)) {
    if ((probabilities[key] ?? 0) > (probabilities[best] ?? 0)) {
      best = key;
    }
  }
  return best;
}

/** Convert the option distribution to the existing systemone wire answer shape. */
export function toWireAnswer(
  question: Question,
  masses: OptionMasses | undefined,
): WireAnswer | undefined {
  if (masses === undefined || masses.coverage < masses.minCoverage) {
    return undefined;
  }
  const probabilities = masses.probabilities;
  if (question.type === 'noul') {
    const noul = probabilities['true'];
    return typeof noul === 'number' ? { type: 'noul', noul } : undefined;
  }
  const keys =
    question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_, i) => String(i));
  if (question.type === 'choice') {
    return {
      type: 'choice',
      choice: argmaxKey(keys, probabilities),
      probabilities: Object.fromEntries(keys.map((key) => [key, probabilities[key] ?? 0])),
    };
  }
  const ordered = question.criteria.map((_, i) => probabilities[String(i)] ?? 0);
  return {
    type: 'score',
    score: ordered.reduce((score, probability, index) => score + index * probability, 0),
    probabilities: Object.fromEntries(
      ordered.map((probability, index) => [String(index), probability]),
    ),
    legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
  };
}
