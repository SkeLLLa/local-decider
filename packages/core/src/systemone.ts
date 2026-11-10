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

function normaliseNoul(wire: WireNoulAnswer): Answer {
  const p = clamp01(wire.noul);
  return {
    type: 'noul',
    answer: p >= 0.5 ? 'true' : 'false',
    probabilities: { false: 1 - p, true: p },
    confidence: noulConfidence(p),
  };
}

function normaliseChoice(wire: WireChoiceAnswer): Answer {
  const [best] = argmax(wire.probabilities);
  return {
    type: 'choice',
    answer: wire.choice === '' ? best : wire.choice,
    probabilities: wire.probabilities,
    // Recomputed for every engine: d3/FastFlowLM report 1 − normalised entropy, a different scale.
    confidence: choiceConfidence(wire.probabilities),
    ...(wire.confidence === undefined ? {} : { engineConfidence: wire.confidence }),
  };
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
 * False for answers an engine could not give: FastFlowLM returns per-question errors such as
 * `{"type":"choice","error":"max_length_exceeded"}` inside a 200, without probabilities.
 */
function usable(wire: WireAnswer): boolean {
  if ('error' in wire) {
    return false;
  }
  if (wire.type === 'noul') {
    return Number.isFinite(wire.noul);
  }
  return typeof wire.probabilities === 'object' && wire.probabilities !== null;
}

/**
 * Map a wire response onto {@link Answer}s. Questions the engine left unanswered are omitted;
 * callers treat a missing answer as "no decision".
 */
export function normaliseAnswers(questions: Questions, response: SystemOneResponse): Answers {
  const out: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const wire = response.answers[id];
    if (wire === undefined || wire.type !== question.type || !usable(wire)) {
      continue;
    }
    if (wire.type === 'noul') {
      out[id] = normaliseNoul(wire);
    } else if (wire.type === 'choice') {
      out[id] = normaliseChoice(wire);
    } else if (question.type === 'score') {
      out[id] = normaliseScore(wire, question.criteria);
    }
  }
  return out;
}
