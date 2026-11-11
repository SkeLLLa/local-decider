/**
 * The gateway's engines and models (`GET /v1/engines`): a lenient parser, the RPC schema it
 * satisfies, and the pure state of each model row on the settings screen.
 */
import { z } from 'zod';

import {
  NOT_CONFIGURED_HINT,
  connectionSchema,
  isConnectable,
  parseConnection,
} from './connection.ts';
import { parsePaths, pathEntrySchema } from './paths.ts';

const text = z.string().nullable();

export const validationSchema = z.object({
  ok: z.boolean(),
  checkedAt: text,
  summary: text,
  lines: z.array(z.string()),
});

const engineSchema = z.object({
  id: z.string(),
  label: z.string(),
  installed: z.boolean(),
  available: z.boolean(),
  detail: text,
  devices: z.array(z.string()),
  validation: validationSchema.nullable(),
  /** Short name for the sidebar and popover, e.g. `NPU`; the id when the gateway has none. */
  tag: z.string(),
  description: z.string(),
  /** False when the engine's output is not calibrated against the policy thresholds. */
  calibrated: z.boolean(),
  capabilities: z.object({ validate: z.boolean() }),
  supported: z.boolean(),
  unsupportedReason: text,
  /** True when the gateway reports connection settings for this engine (OpenAI-like, new gateways). */
  connectable: z.boolean(),
  connection: connectionSchema.nullable(),
});

const modelSchema = z.object({
  id: z.string(),
  engine: z.string(),
  label: z.string(),
  downloadGb: z.number().nullable(),
  memoryGb: z.number().nullable(),
  fits: z.boolean(),
  installed: z.boolean(),
  latencyHint: text,
  recommended: z.boolean(),
});

export const downloadSchema = z.object({
  id: z.string(),
  engine: z.string(),
  model: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  startedAt: text,
  finishedAt: text,
  error: text,
  progress: z.number().nullable(),
});

const activeSchema = z.object({
  engine: text,
  model: text,
  device: text,
  state: text,
  detail: text,
  /** `lazy` loads on the first decision and unloads when idle; `eager` stays loaded. */
  lifecycle: z.enum(['lazy', 'eager']).nullable(),
  idleUnloadMinutes: z.number().nullable(),
  lastUsedAt: text,
});

export const engineCatalogSchema = z.object({
  reachable: z.boolean(),
  active: activeSchema.nullable(),
  totalMemoryGb: z.number().nullable(),
  engines: z.array(engineSchema),
  models: z.array(modelSchema),
  downloads: z.array(downloadSchema),
  paths: z.array(pathEntrySchema),
  /** False for a remote gateway: paths are shown but cannot be changed. */
  pathsEditable: z.boolean(),
});

export type Validation = z.output<typeof validationSchema>;
export type EngineInfo = z.output<typeof engineSchema>;
export type EngineModel = z.output<typeof modelSchema>;
export type Download = z.output<typeof downloadSchema>;
export type ActiveEngine = z.output<typeof activeSchema>;
export type EngineCatalog = z.output<typeof engineCatalogSchema>;

const MAX_ITEMS = 200;
const MAX_LINES = 200;
const MAX_TEXT = 500;

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, MAX_TEXT) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function list<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: T[] = [];
  for (const entry of value.slice(0, MAX_ITEMS)) {
    const parsed = parse(entry);
    if (parsed !== null) {
      out.push(parsed);
    }
  }
  return out;
}

export function parseValidation(value: unknown): Validation | null {
  const v = fields(value);
  if (v === null || typeof v['ok'] !== 'boolean') {
    return null;
  }
  const lines = Array.isArray(v['lines']) ? v['lines'] : [];
  return {
    ok: v['ok'],
    checkedAt: str(v['checkedAt']),
    summary: str(v['summary']),
    lines: lines
      .slice(0, MAX_LINES)
      .filter((l): l is string => typeof l === 'string')
      .map((l) => l.slice(0, MAX_TEXT)),
  };
}

function parseEngine(value: unknown): EngineInfo | null {
  const v = fields(value);
  const id = str(v?.['id']);
  if (v === null || id === null) {
    return null;
  }
  const installed = bool(v['installed'], false);
  const validation = parseValidation(v['validation']);
  const caps = fields(v['capabilities']);
  return {
    id,
    label: str(v['label']) ?? id,
    installed,
    available: bool(v['available'], installed),
    detail: str(v['detail']),
    devices: list(v['devices'], str),
    validation,
    tag: str(v['tag']) ?? id,
    description: str(v['description']) ?? '',
    calibrated: bool(v['calibrated'], true),
    capabilities: { validate: bool(caps?.['validate'], validation !== null) },
    supported: bool(v['supported'], true),
    unsupportedReason: str(v['unsupportedReason']),
    // Only a gateway that sends the `connection` key (null or an object) can save one.
    connectable: isConnectable(id) && 'connection' in v,
    connection: parseConnection(v['connection']),
  };
}

function parseModel(value: unknown): EngineModel | null {
  const v = fields(value);
  const id = str(v?.['id']);
  const engine = str(v?.['engine']);
  if (v === null || id === null || engine === null) {
    return null;
  }
  return {
    id,
    engine,
    label: str(v['label']) ?? id,
    downloadGb: num(v['downloadGb']),
    memoryGb: num(v['memoryGb']),
    // Missing: assume it fits (the gateway refuses with 409 otherwise) but is not downloaded.
    fits: bool(v['fits'], true),
    installed: bool(v['installed'], false),
    latencyHint: str(v['latencyHint']),
    recommended: bool(v['recommended'], false),
  };
}

const DOWNLOAD_STATES = new Set(['running', 'done', 'failed']);

export function parseDownload(value: unknown): Download | null {
  const v = fields(value);
  const id = str(v?.['id']);
  const engine = str(v?.['engine']);
  const model = str(v?.['model']);
  const state = v?.['state'];
  if (v === null || id === null || engine === null || model === null) {
    return null;
  }
  if (typeof state !== 'string' || !DOWNLOAD_STATES.has(state)) {
    return null;
  }
  const progress = num(v['progress']);
  return {
    id,
    engine,
    model,
    state: state as Download['state'],
    startedAt: str(v['startedAt']),
    finishedAt: str(v['finishedAt']),
    error: str(v['error']),
    progress: progress === null ? null : Math.min(1, Math.max(0, progress)),
  };
}

function parseActive(value: unknown): ActiveEngine | null {
  const v = fields(value);
  if (v === null) {
    return null;
  }
  return {
    engine: str(v['engine']),
    model: str(v['model']),
    device: str(v['device']),
    state: str(v['state']),
    detail: str(v['detail']),
    lifecycle: v['lifecycle'] === 'lazy' || v['lifecycle'] === 'eager' ? v['lifecycle'] : null,
    idleUnloadMinutes: num(v['idleUnloadMinutes']),
    lastUsedAt: str(v['lastUsedAt']),
  };
}

/** Lenient read of `GET /v1/engines`: unknown fields are dropped, bad entries skipped. */
export function parseEngineCatalog(body: unknown): EngineCatalog {
  const v = fields(body);
  return {
    reachable: v !== null,
    active: parseActive(v?.['active']),
    totalMemoryGb: num(v?.['totalMemoryGb']),
    engines: list(v?.['engines'], parseEngine),
    models: list(v?.['models'], parseModel),
    downloads: list(v?.['downloads'], parseDownload),
    paths: parsePaths(v?.['paths']),
    pathsEditable: v?.['pathsEditable'] === true,
  };
}

/** Poll `GET /v1/engines` while a download runs or a model loads; stop once nothing does. */
export const ENGINES_POLL_MS = 2500;

export function enginesPollInterval(catalog: EngineCatalog | undefined): number | false {
  if (catalog === undefined) {
    return false;
  }
  const busy =
    catalog.downloads.some((d) => d.state === 'running') || catalog.active?.state === 'starting';
  return busy ? ENGINES_POLL_MS : false;
}

/** The engine whose models to list first: the active one, else the first available, else any. */
export function initialEngine(catalog: EngineCatalog): string | null {
  const active = catalog.active?.engine ?? null;
  if (active !== null && catalog.engines.some((e) => e.id === active)) {
    return active;
  }
  return (catalog.engines.find((e) => e.available) ?? catalog.engines[0])?.id ?? null;
}

export type ModelRowState =
  | { readonly kind: 'in-use'; readonly loading: boolean }
  | { readonly kind: 'switch-device' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'downloading'; readonly progress: number | null }
  | { readonly kind: 'no-fit' }
  | { readonly kind: 'download'; readonly failed: string | null }
  | { readonly kind: 'use' };

export interface ModelRowContext {
  readonly active: ActiveEngine | null;
  readonly downloads: readonly Download[];
  readonly engineAvailable: boolean;
  /** Device chosen on screen; `auto` keeps whatever the gateway uses. */
  readonly device: string;
}

function latestDownload(model: EngineModel, downloads: readonly Download[]): Download | null {
  const mine = downloads.filter((d) => d.engine === model.engine && d.model === model.id);
  return mine.find((d) => d.state === 'running') ?? mine.at(-1) ?? null;
}

function activeState(model: EngineModel, ctx: ModelRowContext): ModelRowState | null {
  const active = ctx.active;
  if (active === null || active.engine !== model.engine || active.model !== model.id) {
    return null;
  }
  const sameDevice =
    ctx.device === 'auto' || active.device === null || active.device === ctx.device;
  return sameDevice
    ? { kind: 'in-use', loading: active.state === 'starting' }
    : { kind: 'switch-device' };
}

/** What a model row shows and offers, in priority order. */
export function modelRowState(model: EngineModel, ctx: ModelRowContext): ModelRowState {
  const active = activeState(model, ctx);
  if (active !== null) {
    return active;
  }
  if (!ctx.engineAvailable) {
    return { kind: 'unavailable' };
  }
  const download = latestDownload(model, ctx.downloads);
  if (download?.state === 'running') {
    return { kind: 'downloading', progress: download.progress };
  }
  if (!model.fits) {
    return { kind: 'no-fit' };
  }
  // A model with no download size is discovered on the endpoint, not fetched by the gateway.
  if (!model.installed && model.downloadGb !== null) {
    return {
      kind: 'download',
      failed: download?.state === 'failed' ? (download.error ?? 'failed') : null,
    };
  }
  return { kind: 'use' };
}

export interface ModelRowView {
  readonly label: string;
  readonly hint: string;
  readonly actionLabel: string;
  /** What pressing does; null when the action is disabled. */
  readonly action: 'use' | 'download' | null;
}

function gb(value: number): string {
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)} GB`;
}

function facts(model: EngineModel): string[] {
  const parts: string[] = [];
  if (model.downloadGb !== null) {
    parts.push(`${gb(model.downloadGb)} download`);
  }
  if (model.memoryGb !== null) {
    parts.push(`${gb(model.memoryGb)} memory`);
  }
  if (model.latencyHint !== null) {
    parts.push(model.latencyHint);
  }
  return parts;
}

function stateNote(
  state: ModelRowState,
  model: EngineModel,
  totalGb: number | null,
): string | null {
  switch (state.kind) {
    case 'in-use':
      return state.loading ? 'Loading; decisions fail open until it is ready.' : null;
    case 'unavailable':
      return 'This engine is not available here.';
    case 'no-fit': {
      const need = model.memoryGb === null ? 'more memory' : `~${gb(model.memoryGb)}`;
      return totalGb === null
        ? `Needs ${need}.`
        : `Needs ${need}; this machine has ${gb(totalGb)}.`;
    }
    case 'download':
      return state.failed === null ? null : `Download failed: ${state.failed}`;
    default:
      return null;
  }
}

function actionFor(
  state: ModelRowState,
  model: EngineModel,
  device: string,
): Omit<ModelRowView, 'label' | 'hint'> {
  switch (state.kind) {
    case 'in-use':
      return { actionLabel: state.loading ? 'Loading…' : 'In use', action: null };
    case 'switch-device':
      return { actionLabel: `Use on ${deviceLabel(device)}`, action: 'use' };
    case 'unavailable':
      return { actionLabel: 'Unavailable', action: null };
    case 'downloading':
      return { actionLabel: 'Downloading…', action: null };
    case 'no-fit':
      return {
        actionLabel: model.memoryGb === null ? 'Does not fit' : `Needs ~${gb(model.memoryGb)}`,
        action: null,
      };
    case 'download': {
      const size = model.downloadGb === null ? '' : ` (${gb(model.downloadGb)})`;
      return {
        actionLabel: `${state.failed === null ? 'Download' : 'Retry download'}${size}`,
        action: 'download',
      };
    }
    default:
      return { actionLabel: 'Use', action: 'use' };
  }
}

/** Label, hint and action of a model row, e.g. `Download (2.0 GB)` or `In use`. */
export function modelRowView(
  model: EngineModel,
  state: ModelRowState,
  options: { readonly device: string; readonly totalMemoryGb: number | null },
): ModelRowView {
  const note = stateNote(state, model, options.totalMemoryGb);
  return {
    label: model.recommended ? `${model.label} · Recommended` : model.label,
    hint: [...facts(model), ...(note === null ? [] : [note])].join(' · '),
    ...actionFor(state, model, options.device),
  };
}

const DEVICE_LABELS: Record<string, string> = {
  auto: 'Gateway default',
  cpu: 'CPU',
  mlx: 'MLX (Apple)',
  mps: 'MPS (Apple)',
  cuda: 'CUDA',
};

function deviceLabel(device: string): string {
  return DEVICE_LABELS[device] ?? device;
}

/** Device select options for an engine that lists devices: "Gateway default" first. */
export function deviceOptions(devices: readonly string[]): { label: string; value: string }[] {
  const ids = ['auto', ...devices.filter((d) => d !== 'auto')];
  return ids.map((d) => ({ label: deviceLabel(d), value: d }));
}

/**
 * A few characters naming the engine, for the sidebar and popover: `NPU`, `PyTorch`. The tag
 * comes from the gateway (`/health` `engineTag`); an old gateway sends none, so use the id.
 */
export function engineTag(engine: string | null, tag: string | null = null): string | null {
  if (engine === null || engine === '') {
    return null;
  }
  return tag === null || tag === '' ? engine : tag;
}

/** The active engine's tag from the catalog, for callers without a `/health` answer. */
export function activeEngineTag(catalog: EngineCatalog): string | null {
  const id = catalog.active?.engine ?? null;
  return engineTag(id, catalog.engines.find((e) => e.id === id)?.tag ?? null);
}

/**
 * Engine select options; an unavailable engine says so in its label. An unsupported engine is
 * hidden unless it is the active one.
 */
export function engineOptions(
  engines: readonly EngineInfo[],
  activeId: string | null = null,
): { label: string; value: string }[] {
  return engines
    .filter((e) => e.supported || e.id === activeId)
    .map((e) => ({
      label: e.available ? e.label : `${e.label} (${unavailableWord(e)})`,
      value: e.id,
    }));
}

function unavailableWord(e: EngineInfo): string {
  if (e.installed) {
    return 'unavailable';
  }
  return e.connectable ? 'not configured' : 'not installed';
}

/** Hint under the engine select: description, why unsupported, and the engine's state. */
export function engineHint(engine: EngineInfo | null): string {
  if (engine === null) {
    return 'The gateway lists no engines.';
  }
  const detail = engine.detail ?? '';
  const note = engine.supported ? '' : (engine.unsupportedReason ?? 'Not supported here.');
  let state = detail;
  if (!engine.available) {
    if (engine.installed) {
      state = `Unavailable here. ${detail}`;
    } else {
      state = engine.connectable ? NOT_CONFIGURED_HINT : `Not installed. ${detail}`;
    }
  }
  return [engine.description, note, state].filter((p) => p !== '').join(' ');
}
