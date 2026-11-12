/**
 * What the gateway would pick (`recommendation` in `GET /v1/engines`) and how it chooses
 * (`active.selectionMode`, `active.fallback`): lenient parsers and the text the settings screen
 * shows. Older gateways send none of it, so every field here may be missing.
 */
import { fields, runtimeOf, str } from './parse.ts';

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
  /** Why the gateway ranks it this way; null on gateways that send no code. */
  readonly code: CandidateCode | null;
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
  /** The engine and device that failed; null on gateways that do not say. */
  readonly engine: string | null;
  readonly device: string | null;
  /** ISO time the failed engine may be retried; null when unknown. */
  readonly retryAt: string | null;
}

export type SelectionMode = 'auto' | 'manual';

export type CandidateCode =
  | 'available'
  | 'no-hardware'
  | 'not-confirmed'
  | 'unsupported-platform'
  | 'no-memory'
  | 'uncalibrated';

const CODES: readonly string[] = [
  'available',
  'no-hardware',
  'not-confirmed',
  'unsupported-platform',
  'no-memory',
  'uncalibrated',
];

export function parseCode(value: unknown): CandidateCode | null {
  return typeof value === 'string' && CODES.includes(value) ? (value as CandidateCode) : null;
}

const MAX_ITEMS = 50;

function parseTarget(value: unknown): Target | null {
  const r = runtimeOf(value);
  if (r === null) {
    return null;
  }
  const { v, engine, model } = r;
  return {
    engine,
    model,
    device: str(v['device']),
    reason: str(v['reason']) ?? '',
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
    backend: str(v['backend']),
    code: parseCode(v['code']),
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
  const reason = str(v?.['reason']);
  return v === null || reason === null
    ? null
    : {
        reason,
        engine: str(v['engine']),
        device: str(v['device']),
        retryAt: str(v['retryAt']),
      };
}

const BACKEND_NAMES: Record<string, string> = {
  NPU: 'AMD NPU',
  CUDA: 'NVIDIA GPU (CUDA)',
  Vulkan: 'GPU (Vulkan)',
  MLX: 'Apple GPU (MLX)',
  MPS: 'Apple GPU (PyTorch MPS)',
  CPU: 'CPU',
};

/** `Apple GPU (MLX)` for `MLX`; an unknown backend is shown as the gateway sent it. */
export function backendName(backend: string): string {
  return BACKEND_NAMES[backend] ?? backend;
}

const DEVICE_BACKENDS: Record<string, string> = {
  mlx: 'MLX',
  mps: 'MPS',
  cuda: 'CUDA',
  cpu: 'CPU',
};

/** The backend an engine runs on, from the device it was started with. */
export function backendOf(engine: string | null, device: string | null): string | null {
  if (engine === 'fastflowlm') {
    return 'NPU';
  }
  if (engine === 'llama-vulkan') {
    return 'Vulkan';
  }
  return device === null ? null : (DEVICE_BACKENDS[device] ?? null);
}

/** Display names the gateway sends in the engine catalog. */
export interface Names {
  readonly engines: ReadonlyMap<string, string>;
  readonly models: ReadonlyMap<string, { label: string; latencyHint: string | null }>;
}

export function namesOf(catalog: {
  engines: readonly { id: string; label: string }[];
  models: readonly { engine: string; id: string; label: string; latencyHint: string | null }[];
}): Names {
  return {
    engines: new Map(catalog.engines.map((e) => [e.id, e.label])),
    models: new Map(
      catalog.models.map((m) => [
        `${m.engine}|${m.id}`,
        { label: m.label, latencyHint: m.latencyHint },
      ]),
    ),
  };
}

/** What the gateway reports as running; `ActiveEngine` fits it. */
export interface ActiveInfo {
  readonly engine: string | null;
  readonly model: string | null;
  readonly device: string | null;
  readonly resolvedDevice: string | null;
  readonly backend: string | null;
  readonly state: string | null;
  readonly selectionMode: SelectionMode | null;
  readonly fallback: Fallback | null;
}

function runningBackend(active: ActiveInfo): string | null {
  return (
    active.backend ??
    backendOf(active.engine, active.resolvedDevice) ??
    backendOf(active.engine, active.device)
  );
}

/** `Strands Decider · Apple GPU (MLX)`; an engine on no known backend shows its label alone. */
function fullName(engine: string, backend: string | null, names: Names): string {
  const label = names.engines.get(engine) ?? engine;
  return backend === null ? label : `${label} · ${backendName(backend)}`;
}

/** `Apple GPU (MLX)`; the engine's label when it has no backend of its own. */
function shortName(engine: string, backend: string | null, names: Names): string {
  return backend === null ? (names.engines.get(engine) ?? engine) : backendName(backend);
}

const STATES: Record<string, { text: string; tone: 'success' | 'error' | 'info' }> = {
  ready: { text: 'Ready', tone: 'success' },
  starting: { text: 'Loading', tone: 'info' },
  stopped: { text: 'Stopped', tone: 'info' },
  failed: { text: 'Failed', tone: 'error' },
};

const MAX_LATENCY_HINT = 40;

export interface RunningView {
  readonly value: string;
  readonly hint: string;
  readonly state: { readonly text: string; readonly tone: 'success' | 'error' | 'info' } | null;
}

/** The running engine as a name, a state badge and `strands-decider 2B · ~66 ms`. */
export function runningView(active: ActiveInfo | null, names: Names): RunningView | null {
  if (active?.engine == null) {
    return null;
  }
  const model = names.models.get(`${active.engine}|${active.model ?? ''}`);
  const latency =
    model?.latencyHint != null && model.latencyHint.length <= MAX_LATENCY_HINT
      ? model.latencyHint
      : null;
  return {
    value: fullName(active.engine, runningBackend(active), names),
    hint: [model?.label ?? null, latency].filter((p) => p !== null).join(' · '),
    state: STATES[active.state ?? ''] ?? null,
  };
}

/** The Engine select's value for automatic selection; never sent as an engine id. */
export const AUTO_ENGINE = '__auto__';
export const AUTO_OPTION_LABEL = 'Automatic — best for this computer';

/** Hint when Automatic is selected and the gateway already runs in automatic mode. */
export function autoHint(active: ActiveInfo | null, names: Names): string {
  const running = runningView(active, names);
  const now = running === null ? '' : `Now using ${running.value}. `;
  return `${now}Falls back to the next engine if it fails.`;
}

/** Hint when Automatic is selected but the gateway is in manual mode. */
export const USE_AUTO_HINT =
  'Picks the fastest engine this computer supports and falls back if it fails.';

/** Hint on a specific engine while the gateway is in automatic mode. */
export const LEAVES_AUTO_HINT = 'Picking an engine turns off automatic selection.';

export function installCommand(t: Target, backend: string | null): string {
  if (t.engine === 'fastflowlm') {
    return [
      `Install FastFlowLM with your package manager or from ${FLM_INSTALL_URL}, then:`,
      `local-decider engine install --engine fastflowlm --model ${t.model}`,
    ].join('\n');
  }
  if (t.engine === 'llama-vulkan') {
    return `local-decider engine install --engine llama-vulkan --model ${t.model}`;
  }
  const flavor =
    backend === 'MLX' || backend === 'CUDA' ? ` --flavor ${backend.toLowerCase()}` : '';
  return `local-decider engine install${flavor}`;
}

/** FastFlowLM is installed by the user; local-decider never downloads it. */
const FLM_INSTALL_URL = 'https://github.com/FastFlowLM/FastFlowLM';

export function minutes(seconds: number): string {
  if (seconds < 60) {
    return 'under a minute';
  }
  return `${String(Math.ceil(seconds / 60))} min`;
}

/** `Apple GPU (MLX) failed; retrying in 2 min.` while automatic mode runs a backup engine. */
export function fallbackLine(
  active: ActiveInfo | null,
  names: Names,
  now: number = Date.now(),
): string | null {
  const fb = active?.fallback;
  if (fb == null) {
    return null;
  }
  const who =
    fb.engine === null
      ? 'The preferred engine'
      : shortName(fb.engine, backendOf(fb.engine, fb.device), names);
  const at = fb.retryAt === null ? Number.NaN : Date.parse(fb.retryAt);
  if (Number.isNaN(at)) {
    return `${who} failed; it will be retried.`;
  }
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  return `${who} failed; retrying in ${minutes(seconds)}.`;
}

export interface EngineRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
}

export interface EnginesView {
  /** `3 ready`. */
  readonly summary: string;
  readonly rows: readonly EngineRow[];
}

const HIDDEN: readonly (CandidateCode | null)[] = ['no-hardware', 'unsupported-platform'];

const NOTE: Partial<Record<CandidateCode, string>> = {
  'not-confirmed': 'Not detected on this computer',
  'no-memory': 'Not enough memory',
  'uncalibrated': "Manual only · its confidence isn't calibrated for automatic use",
};

function rowDetail(c: RankedCandidate, speed: string): string {
  const note = c.code === null ? undefined : NOTE[c.code];
  if (note !== undefined) {
    return note;
  }
  if (!c.eligible) {
    return 'Not used automatically';
  }
  return c.ready ? `Ready${speed}` : 'Not installed';
}

/** ` · fastest`, ` · slowest, works everywhere`; empty for the middle of the ladder. */
function speedNote(c: RankedCandidate, firstReady: boolean, onlyOne: boolean): string {
  if (c.backend === 'CPU') {
    return onlyOne ? ' · works everywhere' : ' · slowest, works everywhere';
  }
  return firstReady && !onlyOne ? ' · fastest' : '';
}

/** Engines that can run on this computer, with a plain status each; null when there is no ranking. */
export function enginesView(rec: Recommendation | null, names: Names): EnginesView | null {
  if (rec === null) {
    return null;
  }
  const shown = rec.candidates.filter((c) => c.supported && !HIDDEN.includes(c.code));
  if (shown.length === 0) {
    return null;
  }
  const readyList = shown.filter((c) => c.eligible && c.ready);
  const first = readyList[0];
  const rows = shown.map((c) => ({
    key: `${c.engine}|${c.device ?? ''}|${c.model}`,
    label: shortName(c.engine, c.backend, names),
    detail: rowDetail(c, speedNote(c, c === first, readyList.length === 1)),
  }));
  return { summary: `${String(readyList.length)} ready`, rows };
}

/**
 * Where an engine runs, for the engine select's hint: its running backend, else the best
 * candidate's. Null for an engine that is not tied to hardware (a server you configure).
 */
export function engineWhere(
  engine: string,
  active: ActiveInfo | null,
  rec: Recommendation | null,
): string | null {
  const mine = rec?.candidates.filter((c) => c.engine === engine && c.supported) ?? [];
  const backend =
    (active?.engine === engine ? runningBackend(active) : null) ??
    (mine.find((c) => c.eligible && c.ready) ?? mine.find((c) => c.eligible))?.backend ??
    null;
  return backend === null ? null : backendName(backend);
}
