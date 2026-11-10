/** The gateway's decision models (`GET /models`) and the plugin's model choice. */
import { STRANDS_MODELS } from './constants.ts';
import type { ModelOption } from './presets.ts';

export interface CatalogModel {
  readonly id: string;
  /** Approximate memory needed to serve it, when the gateway says. */
  readonly memoryGb: number | null;
}

export interface ModelCatalog {
  /** Model the gateway serves now. */
  readonly active: string | null;
  readonly device: string | null;
  /** The gateway can switch models at runtime (`POST /v1/engine`). */
  readonly switchable: boolean;
  readonly models: CatalogModel[];
}

const MAX_MODELS = 200;

function catalogModel(entry: unknown): CatalogModel | null {
  if (typeof entry === 'string') {
    return { id: entry, memoryGb: null };
  }
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id = record['id'] ?? record['name'];
  const memory = record['memoryGb'];
  if (typeof id !== 'string') {
    return null;
  }
  return { id, memoryGb: typeof memory === 'number' && Number.isFinite(memory) ? memory : null };
}

function shortString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= 300 ? value : null;
}

/**
 * Tolerant read of `GET /models`: `[...]` or `{models: [...]}` of strings or `{id}` objects, plus
 * optional `active`, `device` and `switchable`. Unknown shapes yield an empty catalog.
 */
export function gatewayCatalog(body: unknown): ModelCatalog {
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const list = Array.isArray(body)
    ? (body as unknown[])
    : Array.isArray(record['models'])
      ? (record['models'] as unknown[])
      : [];
  const models: CatalogModel[] = [];
  for (const entry of list.slice(0, MAX_MODELS)) {
    const model = catalogModel(entry);
    if (
      model !== null &&
      shortString(model.id) !== null &&
      !models.some((m) => m.id === model.id)
    ) {
      models.push(model);
    }
  }
  return {
    active: shortString(record['active']),
    device: shortString(record['device']),
    switchable: record['switchable'] === true,
    models,
  };
}

/** `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` → `2B-qwen3.5-v1-2610`. */
export function shortModel(model: string): string {
  return model.replace(/^StrandsAgents\//, '').replace(/^strands-decider-/, '');
}

/**
 * Family and size, for tight spaces: `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` →
 * `qwen3.5 2B`. Ids that do not look like `<size>-<family>-…` fall back to `shortModel`.
 */
export function compactModel(model: string): string {
  const short = shortModel(model);
  const [size, family] = short.split('-');
  return size !== undefined && family !== undefined && /^E?\d+B$/.test(size)
    ? `${family} ${size}`
    : short;
}

function label(model: CatalogModel): string {
  return model.memoryGb === null
    ? shortModel(model.id)
    : `${shortModel(model.id)} · ~${String(model.memoryGb)} GB`;
}

/**
 * Options for the decision-model select: "gateway config" first, then the gateway's models (or
 * the built-in list when it lists none), then the saved value if neither has it.
 */
export function decisionModelOptions(
  catalog: Pick<ModelCatalog, 'models' | 'active'>,
  current: string,
): ModelOption[] {
  const models: CatalogModel[] = catalog.models.length > 0 ? [...catalog.models] : [];
  for (const known of STRANDS_MODELS) {
    if (!models.some((m) => m.id === known.id)) {
      models.push(known);
    }
  }
  for (const id of [catalog.active, current]) {
    if (id !== null && id !== '' && !models.some((m) => m.id === id)) {
      models.push({ id, memoryGb: null });
    }
  }
  const configLabel =
    catalog.active === null ? 'Gateway config' : `Gateway config (${shortModel(catalog.active)})`;
  return [
    { label: configLabel, value: '' },
    ...models.map((m) => ({ label: label(m), value: m.id })),
  ];
}

export interface EngineSelection {
  readonly model: string;
  readonly device: string;
}

/**
 * The selection to send so the gateway serves the chosen model, or null when it already does
 * (or the choice is "gateway config"). Device `auto` matches whatever the gateway reports.
 */
export function pendingSelection(
  wanted: EngineSelection,
  live: { readonly model: string | null; readonly device: string | null },
): EngineSelection | null {
  if (wanted.model === '') {
    return null;
  }
  const sameModel = live.model === wanted.model;
  const sameDevice =
    wanted.device === 'auto' || live.device === null || live.device === wanted.device;
  return sameModel && sameDevice ? null : { model: wanted.model, device: wanted.device };
}
