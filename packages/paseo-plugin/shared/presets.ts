/** Routing presets (`route:fast|standard|deep`) → a Paseo provider/model/mode, and model lists. */
import { ROUTING_PRESETS, STRANDS_MODELS, type RoutingPreset } from './constants.ts';

export interface PresetTarget {
  readonly provider: string;
  readonly model: string;
  /** '' = leave the provider's default mode. */
  readonly modeId: string;
}

export interface PresetSetting {
  readonly model: string;
  readonly modeId: string;
}

/** `route:deep` → `deep`; anything else (or an unknown preset) → null. */
export function presetFromAction(action: string): RoutingPreset | null {
  if (!action.startsWith('route:')) {
    return null;
  }
  const name = action.slice('route:'.length);
  return (ROUTING_PRESETS as readonly string[]).includes(name) ? (name as RoutingPreset) : null;
}

/** `provider/model-id` (model ids may contain `/`) → parts, or null when unmapped/malformed. */
export function parsePresetModel(value: string): { provider: string; model: string } | null {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return null;
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

export function presetTarget(
  presets: Readonly<Record<RoutingPreset, PresetSetting>>,
  action: string,
): PresetTarget | null {
  const preset = presetFromAction(action);
  if (preset === null) {
    return null;
  }
  const setting = presets[preset];
  const parsed = parsePresetModel(setting.model.trim());
  return parsed === null ? null : { ...parsed, modeId: setting.modeId.trim() };
}

interface ConfigLike {
  readonly provider: string;
  readonly model?: string;
  readonly modeId?: string;
  readonly thinkingOptionId?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly featureValues?: Record<string, unknown>;
}

/**
 * Apply a preset to an agent config. Same provider: change model (and mode when the preset names
 * one). Another provider: provider-specific fields (mode, thinking option, provider options,
 * feature values) are dropped so the new provider starts from its defaults.
 */
export function applyPreset<C extends ConfigLike>(config: C, target: PresetTarget): C {
  if (config.provider === target.provider) {
    return {
      ...config,
      model: target.model,
      ...(target.modeId === '' ? {} : { modeId: target.modeId }),
    };
  }
  const {
    modeId: _mode,
    thinkingOptionId: _thinking,
    providerOptions: _options,
    featureValues: _features,
    ...rest
  } = config;
  return {
    ...rest,
    provider: target.provider,
    model: target.model,
    ...(target.modeId === '' ? {} : { modeId: target.modeId }),
  } as unknown as C;
}

export interface ModelOption {
  readonly label: string;
  readonly value: string;
}

interface ProviderModelsLike {
  readonly provider: string;
  readonly models?:
    | readonly {
        readonly id: string;
        readonly label: string;
        readonly isSelectable?: boolean | undefined;
      }[]
    | undefined;
}

/** Options for the preset selects, from `providers.listModels()` results. */
export function presetModelOptions(results: readonly ProviderModelsLike[]): ModelOption[] {
  const options: ModelOption[] = [{ label: 'Not mapped', value: '' }];
  for (const result of results) {
    for (const model of result.models ?? []) {
      if (model.isSelectable === false) {
        continue;
      }
      options.push({
        label: `${result.provider} · ${model.label || model.id}`,
        value: `${result.provider}/${model.id}`,
      });
    }
  }
  return options;
}

/** Keep the saved value selectable even when the provider list no longer has it. */
export function withCurrent(options: readonly ModelOption[], current: string): ModelOption[] {
  if (current === '' || options.some((o) => o.value === current)) {
    return [...options];
  }
  return [...options, { label: `${current} (not listed)`, value: current }];
}

function modelIdOf(entry: unknown): string | null {
  if (typeof entry === 'string') {
    return entry;
  }
  if (typeof entry === 'object' && entry !== null) {
    const id = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

/**
 * Model ids from the gateway's `GET /models`, tolerating `[...]` and `{models: [...]}` of strings
 * or `{id}` objects. Unknown shapes yield [].
 */
export function gatewayModelIds(body: unknown): string[] {
  const list = Array.isArray(body)
    ? (body as unknown[])
    : typeof body === 'object' &&
        body !== null &&
        Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : [];
  const ids: string[] = [];
  for (const entry of list.slice(0, 200)) {
    const id = modelIdOf(entry);
    if (id !== null && id.length > 0 && id.length <= 300 && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** Known StrandsAgents models first, then gateway-discovered ones, then the saved value. */
export function decisionModelOptions(
  discovered: readonly string[],
  current: string,
): ModelOption[] {
  const ids: string[] = [...STRANDS_MODELS];
  for (const id of [...discovered, current]) {
    if (id !== '' && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids.map((id) => ({ label: id.replace(/^StrandsAgents\//, ''), value: id }));
}
