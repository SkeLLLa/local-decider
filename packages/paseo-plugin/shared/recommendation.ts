/**
 * What the gateway would pick (`recommendation` in `GET /v1/engines`) and how it chooses
 * (`active.selectionMode`, `active.fallback`): lenient parsers and the text the settings screen
 * shows. Older gateways send none of it, so every field here may be missing.
 */
export interface Target {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  readonly reason: string;
  /** True when the user's own selection is what the gateway reports, not its ranking. */
  readonly explicit: boolean;
}

export interface RankedCandidate {
  readonly engine: string;
  readonly model: string;
  readonly device: string | null;
  /** `NPU`, `CUDA`, `MLX`, `MPS` or `CPU`; null when the gateway names none. */
  readonly backend: string | null;
  /** May be chosen automatically. */
  readonly eligible: boolean;
  /** False when the engine can never run on this host. Older gateways omit it: assume true. */
  readonly supported: boolean;
  /** Installed; false means it would need installing first. */
  readonly ready: boolean;
  readonly reason: string;
}

export interface Recommendation {
  /** The user's own selection in manual mode, otherwise what automatic selection picks. */
  readonly recommended: Target | null;
  /** What automatic selection would pick, whatever is selected now. */
  readonly automatic: Target | null;
  /** Eligible candidates in ladder order, then ineligible ones. */
  readonly candidates: RankedCandidate[];
}

export interface Fallback {
  readonly reason: string;
  /** ISO time the failed engine may be retried; null when unknown. */
  readonly retryAt: string | null;
}

export type SelectionMode = 'auto' | 'manual';

type Fields = Record<string, unknown>;

const MAX_ITEMS = 50;
const MAX_TEXT = 500;

function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : null;
}

function parseTarget(value: unknown): Target | null {
  const v = fields(value);
  const engine = text(v?.['engine']);
  const model = text(v?.['model']);
  if (v === null || engine === null || model === null) {
    return null;
  }
  return {
    engine,
    model,
    device: text(v['device']),
    reason: text(v['reason']) ?? '',
    explicit: v['explicit'] === true,
  };
}

function parseCandidate(value: unknown): RankedCandidate | null {
  const target = parseTarget(value);
  const v = fields(value);
  if (target === null || v === null) {
    return null;
  }
  return {
    engine: target.engine,
    model: target.model,
    device: target.device,
    backend: text(v['backend']),
    eligible: v['eligible'] === true,
    supported: v['supported'] !== false,
    ready: v['ready'] === true,
    reason: target.reason,
  };
}

/** Lenient read of `recommendation`; null when the gateway sends none. */
export function parseRecommendation(value: unknown): Recommendation | null {
  const v = fields(value);
  if (v === null) {
    return null;
  }
  const raw: unknown[] = Array.isArray(v['candidates']) ? v['candidates'] : [];
  const recommended = parseTarget(v['recommended']);
  // A gateway without `automatic` only sends the ranking's pick as `recommended`.
  const automatic =
    parseTarget(v['automatic']) ?? (recommended?.explicit === false ? recommended : null);
  return {
    recommended,
    automatic,
    candidates: raw
      .slice(0, MAX_ITEMS)
      .map(parseCandidate)
      .filter((c): c is RankedCandidate => c !== null),
  };
}

export function parseSelectionMode(value: unknown): SelectionMode | null {
  return value === 'auto' || value === 'manual' ? value : null;
}

/** Lenient read of `active.fallback`; absent while no fallback is in effect. */
export function parseFallback(value: unknown): Fallback | null {
  const v = fields(value);
  const reason = text(v?.['reason']);
  return v === null || reason === null ? null : { reason, retryAt: text(v['retryAt']) };
}

const BACKEND_NAMES: Record<string, string> = {
  NPU: 'AMD NPU',
  CUDA: 'NVIDIA CUDA',
  MLX: 'Apple MLX',
  MPS: 'Apple MPS',
  CPU: 'CPU',
};

type EngineLabels = ReadonlyMap<string, string>;

/** `Strands Decider · Apple MLX`; an engine without a backend shows its model instead. */
function describe(
  c: { engine: string; model: string; backend: string | null },
  labels: EngineLabels,
): string {
  const engine = labels.get(c.engine) ?? c.engine;
  return `${engine} · ${c.backend === null ? c.model : (BACKEND_NAMES[c.backend] ?? c.backend)}`;
}

export interface CandidateView {
  readonly key: string;
  readonly label: string;
  readonly status: 'Ready' | 'Not installed' | 'Not eligible';
  readonly eligible: boolean;
  readonly reason: string;
}

export interface Summary {
  /** `Recommended`, `Automatic would pick`, or `Automatic selection`. */
  readonly label: string;
  /** Short: engine and backend. */
  readonly value: string;
  readonly reason: string;
}

export interface RecommendationView {
  readonly summary: Summary;
  /** Candidates that can run on this host: eligible first. */
  readonly candidates: readonly CandidateView[];
}

function statusOf(c: RankedCandidate): CandidateView['status'] {
  if (!c.eligible) {
    return 'Not eligible';
  }
  return c.ready ? 'Ready' : 'Not installed';
}

interface Choice {
  readonly engine: string;
  readonly device: string | null;
}

function sameChoice(a: Choice, b: Choice): boolean {
  return a.engine === b.engine && a.device === b.device;
}

function summaryOf(rec: Recommendation, mode: SelectionMode | null, labels: EngineLabels): Summary {
  const auto = rec.automatic;
  const named = (t: Target): string =>
    describe(
      { ...t, backend: rec.candidates.find((c) => sameChoice(c, t))?.backend ?? null },
      labels,
    );
  const manual = mode === 'manual' || rec.recommended?.explicit === true;
  if (!manual) {
    return auto === null
      ? { label: 'Recommended', value: 'None eligible', reason: 'No engine is eligible here.' }
      : { label: 'Recommended', value: named(auto), reason: auto.reason };
  }
  if (auto === null) {
    return { label: 'Automatic would pick', value: 'None eligible', reason: '' };
  }
  if (rec.recommended !== null && sameChoice(auto, rec.recommended)) {
    return { label: 'Automatic would pick', value: 'Matches your selection', reason: '' };
  }
  return { label: 'Automatic would pick', value: named(auto), reason: auto.reason };
}

/** The summary row and the candidates that can run here; null when there is nothing to show. */
export function recommendationView(
  rec: Recommendation | null,
  mode: SelectionMode | null,
  labels: EngineLabels,
): RecommendationView | null {
  if (rec === null || (rec.automatic === null && rec.candidates.length === 0)) {
    return null;
  }
  return {
    summary: summaryOf(rec, mode, labels),
    candidates: rec.candidates
      .filter((c) => c.supported)
      .map((c) => ({
        key: `${c.engine}|${c.device ?? ''}|${c.model}`,
        label: describe(c, labels),
        status: statusOf(c),
        eligible: c.eligible,
        reason: c.reason,
      })),
  };
}

/** `Automatic` or `Manual`, or null for a gateway that does not say. */
export function selectionModeLabel(mode: SelectionMode | null): string | null {
  if (mode === null) {
    return null;
  }
  return mode === 'auto' ? 'Automatic' : 'Manual';
}

/** One line for an active fallback: why it happened and when the engine is retried. */
export function fallbackText(fallback: Fallback | null, now: number = Date.now()): string | null {
  if (fallback === null) {
    return null;
  }
  const at = fallback.retryAt === null ? Number.NaN : Date.parse(fallback.retryAt);
  if (Number.isNaN(at)) {
    return fallback.reason;
  }
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  return `${fallback.reason}; retry in ${String(seconds)} s`;
}
