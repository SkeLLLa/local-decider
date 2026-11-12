/**
 * The `/v1/systemone` wire contract (Strands Decider, also served by Laya and GLiClass servers)
 * and its normalisation into one answer shape with a calibrated confidence for every type.
 */

export type QuestionType = 'noul' | 'choice' | 'score';

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: string;
  readonly criteria?: { readonly true?: string; readonly false?: string };
}

export interface ChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: string;
  /** Option id → one or two sentence description. 2..255 options. */
  readonly criteria: Readonly<Record<string, string | null>>;
}

export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: string;
  /** Ordered levels, lowest first. 2..10 levels. */
  readonly criteria: readonly string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Readonly<Record<string, Question>>;

export interface SystemOneRequest {
  readonly state: string | Readonly<Record<string, unknown>> | readonly unknown[];
  readonly questions: Questions;
  readonly model?: string;
}

export interface WireNoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

export interface WireChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export interface WireScoreAnswer {
  readonly type: 'score';
  readonly score: number;
  readonly legend?: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence?: number;
}

export type WireAnswer = WireNoulAnswer | WireChoiceAnswer | WireScoreAnswer;

export interface SystemOneResponse {
  readonly model?: string;
  readonly answers: Readonly<Record<string, WireAnswer>>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly latency_ms?: number;
}

/** One answer in a shape every engine maps onto. */
export interface Answer {
  readonly type: QuestionType;
  /** noul: `true`/`false`; choice: the option id; score: the most likely level label. */
  readonly answer: string;
  /** Probability per option (noul: `true`/`false`; score: per level label). Sums to ~1. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** 0 = uniform, 1 = certain. Same formulas as Strands Decider for every engine. */
  readonly confidence: number;
  /** score only: the expected level index. */
  readonly score?: number;
  /** The engine's own confidence, kept for reference; thresholds use `confidence`. */
  readonly engineConfidence?: number;
}

export type Answers = Readonly<Record<string, Answer>>;

function argmax(probs: Readonly<Record<string, number>>): [string, number] {
  let best: [string, number] = ['', -1];
  for (const [key, p] of Object.entries(probs)) {
    if (p > best[1]) {
      best = [key, p];
    }
  }
  return best;
}

/** Strands' choice confidence: (N·p_max − 1)/(N − 1). Uniform = 0, one-hot = 1. */
export function choiceConfidence(probs: Readonly<Record<string, number>>): number {
  const n = Object.keys(probs).length;
  if (n < 2) {
    return 1;
  }
  const [, pMax] = argmax(probs);
  return clamp01((n * pMax - 1) / (n - 1));
}

/** Noul confidence: |2p − 1| (the Strands docstring's definition). */
export function noulConfidence(pTrue: number): number {
  return clamp01(Math.abs(2 * pTrue - 1));
}

/** Score confidence: (σ_max − σ)/σ_max over level indices (Strands' formula with σ_floor = 0). */
export function scoreConfidence(levelProbs: readonly number[]): number {
  const levels = levelProbs.length;
  if (levels < 2) {
    return 1;
  }
  const mean = levelProbs.reduce((acc, p, i) => acc + p * i, 0);
  const variance = levelProbs.reduce((acc, p, i) => acc + p * (i - mean) ** 2, 0);
  const sigmaMax = (levels - 1) / 2;
  return clamp01((sigmaMax - Math.sqrt(variance)) / sigmaMax);
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** How far a probability map may stray from summing to 1 before the answer is rejected. */
const PROBABILITY_SUM_TOLERANCE = 0.05;

/** Noul: the answer is `true` only when p(true) is strictly above 0.5; an exact tie is `false`. */
function normaliseNoul(wire: WireNoulAnswer): Answer {
  const p = wire.noul;
  return {
    type: 'noul',
    answer: p > 0.5 ? 'true' : 'false',
    probabilities: { false: 1 - p, true: p },
    confidence: noulConfidence(p),
  };
}

function normaliseChoice(wire: WireChoiceAnswer): Answer {
  const [best] = argmax(wire.probabilities);
  const answer: Answer = {
    type: 'choice',
    // Always the argmax, even if a valid wire.choice names a different option.
    answer: best,
    probabilities: wire.probabilities,
    // Recomputed for every engine: d3/FastFlowLM report 1 − normalised entropy, a different scale.
    confidence: choiceConfidence(wire.probabilities),
  };
  return wire.confidence === undefined ? answer : { ...answer, engineConfidence: wire.confidence };
}

function normaliseScore(wire: WireScoreAnswer, levels: readonly string[]): Answer {
  const byIndex = levels.map((_, i) => wire.probabilities[String(i)] ?? 0);
  const probabilities = Object.fromEntries(levels.map((label, i) => [label, byIndex[i] ?? 0]));
  const [best] = argmax(probabilities);
  return {
    type: 'score',
    answer: best,
    probabilities,
    confidence: scoreConfidence(byIndex),
    ...(wire.confidence === undefined ? {} : { engineConfidence: wire.confidence }),
    score: wire.score,
  };
}

/**
 * True when `probs` has one finite, non-negative number for every known key and sums to 1 within
 * {@link PROBABILITY_SUM_TOLERANCE}.
 */
function validProbabilities(probs: unknown, known: readonly string[]): boolean {
  if (typeof probs !== 'object' || probs === null || Array.isArray(probs)) {
    return false;
  }
  const entries = Object.entries(probs);
  if (entries.length < 2 || known.length < 2 || entries.length !== known.length) {
    return false;
  }
  let sum = 0;
  for (const [key, p] of entries) {
    if (!known.includes(key) || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      return false;
    }
    sum += p;
  }
  return (
    known.every((key) => Object.hasOwn(probs, key)) &&
    Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE
  );
}

/** Choice option ids, or score level indices (`"0"`, `"1"`, ...), the wire keys probabilities by. */
function optionIds(question: Question): string[] {
  if (question.type === 'choice') {
    return Object.keys(question.criteria);
  }
  if (question.type === 'score') {
    return question.criteria.map((_, i) => String(i));
  }
  return ['true', 'false'];
}

/**
 * False for answers an engine could not give or that do not fit the question: FastFlowLM returns
 * per-question errors such as `{"type":"choice","error":"max_length_exceeded"}` inside a 200,
 * and some engines key probabilities by label or return NaN, negative or non-normalised values.
 * A dropped answer means "no decision", never a confident one.
 */
function usable(wire: WireAnswer, question: Question): boolean {
  if ('error' in wire) {
    return false;
  }
  if (wire.type === 'noul') {
    return Number.isFinite(wire.noul) && wire.noul >= 0 && wire.noul <= 1;
  }
  const ids = optionIds(question);
  if (!validProbabilities(wire.probabilities, ids)) {
    return false;
  }
  if (wire.type === 'choice') {
    return wire.choice === '' || ids.includes(wire.choice);
  }
  return Number.isFinite(wire.score) && wire.score >= 0 && wire.score <= ids.length - 1;
}

/**
 * Map a wire response onto {@link Answer}s. Questions the engine left unanswered are omitted;
 * callers treat a missing answer as "no decision".
 */
export function normaliseAnswers(questions: Questions, response: SystemOneResponse): Answers {
  const out: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const wire = response.answers[id];
    if (wire === undefined || wire.type !== question.type || !usable(wire, question)) {
      continue;
    }
    if (wire.type === 'noul') {
      out[id] = normaliseNoul(wire);
    } else if (wire.type === 'choice' && question.type === 'choice') {
      out[id] = normaliseChoice(wire);
    } else if (wire.type === 'score' && question.type === 'score') {
      out[id] = normaliseScore(wire, question.criteria);
    }
  }
  return out;
}
