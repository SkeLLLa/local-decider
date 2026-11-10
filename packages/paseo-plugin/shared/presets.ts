/** Routing presets (`route:<preset>`) → a Paseo provider/model/mode, and model lists. */

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

/** `route:deep` → `deep`; anything else → null. */
export function presetFromAction(action: string): string | null {
  if (!action.startsWith('route:')) {
    return null;
  }
  const name = action.slice('route:'.length);
  return name === '' ? null : name;
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
  presets: Readonly<Record<string, PresetSetting>>,
  action: string,
): PresetTarget | null {
  const preset = presetFromAction(action);
  const setting = preset === null || !Object.hasOwn(presets, preset) ? undefined : presets[preset];
  if (setting === undefined) {
    return null;
  }
  const parsed = parsePresetModel(setting.model.trim());
  return parsed === null ? null : { ...parsed, modeId: setting.modeId.trim() };
}

/** The gateway's resolved `route` (`provider/model`, optional mode) as a target, or null. */
export function routeTarget(route: { model: unknown; mode?: unknown }): PresetTarget | null {
  const parsed = typeof route.model === 'string' ? parsePresetModel(route.model.trim()) : null;
  const modeId = typeof route.mode === 'string' ? route.mode.trim() : '';
  return parsed === null ? null : { ...parsed, modeId };
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
