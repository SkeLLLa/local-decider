/**
 * What the gateway recommends (`recommendation` in `GET /v1/engines`) and how it chooses
 * (`active.selectionMode`, `active.fallback`): lenient parsers and the text the settings screen
 * shows. Older gateways send none of it, so every field here may be missing.
 */
export interface RecommendedTarget {
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
  /** Installed; false means it would need installing first. */
  readonly ready: boolean;
  readonly reason: string;
}

export interface Recommendation {
  readonly recommended: RecommendedTarget | null;
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

function parseTarget(value: unknown): RecommendedTarget | null {
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
  const candidates = raw
    .slice(0, MAX_ITEMS)
    .map(parseCandidate)
    .filter((c): c is RankedCandidate => c !== null);
  return { recommended: parseTarget(v['recommended']), candidates };
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

const BACKEND_NAMES: Record<string, string> = { NPU: 'NPU', CUDA: 'NVIDIA GPU', MLX: 'Apple MLX' };

function targetName(t: { engine: string; model: string; backend?: string | null }): string {
  const backend =
    t.backend === undefined || t.backend === null
      ? ''
      : ` on ${BACKEND_NAMES[t.backend] ?? t.backend}`;
  return `${t.engine} · ${t.model}${backend}`;
}

export interface RecommendationView {
  /** The engine the gateway would pick (or the user's own selection). */
  readonly headline: string;
  readonly reason: string;
  readonly candidates: readonly { readonly label: string; readonly note: string }[];
}

function candidateNote(c: RankedCandidate): string {
  const state = !c.eligible ? 'not eligible' : c.ready ? 'ready' : 'not installed';
  return c.reason === '' ? state : `${state} · ${c.reason}`;
}

/** The ranked list and its headline; null when there is nothing to show. */
export function recommendationView(rec: Recommendation | null): RecommendationView | null {
  if (rec === null || (rec.recommended === null && rec.candidates.length === 0)) {
    return null;
  }
  const pick = rec.recommended;
  const same = (c: RankedCandidate): boolean =>
    c.engine === pick?.engine && c.model === pick.model && c.device === pick.device;
  const backend = rec.candidates.find(same)?.backend ?? null;
  return {
    headline:
      pick === null ? 'No engine is eligible on this machine' : targetName({ ...pick, backend }),
    reason: pick?.reason ?? '',
    candidates: rec.candidates.map((c) => ({
      label: targetName(c),
      note: candidateNote(c),
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
