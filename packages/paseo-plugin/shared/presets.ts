/**
 * Routing presets (`route:<preset>`) → a Paseo provider, model, mode and thinking level (or a
 * Paseo agent profile that bundles them), and model lists.
 */

export interface PresetTarget {
  readonly provider: string;
  /** '' = the provider's default model. */
  readonly model: string;
  /** '' = leave the provider's default mode. */
  readonly modeId: string;
  /** '' = the model's default thinking option. */
  readonly thinkingOptionId?: string;
  /** From a profile; replaces the agent's feature values. */
  readonly featureValues?: Record<string, unknown>;
}

/** The fields of a Paseo agent profile routing uses (`paseo.config.get()` → `agentProfiles`). */
export interface ProfileLike {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly model?: string | undefined;
  readonly modeId?: string | undefined;
  readonly thinkingOptionId?: string | undefined;
  readonly featureValues?: Record<string, unknown> | undefined;
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

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function profileTarget(profile: ProfileLike): PresetTarget {
  return {
    provider: profile.provider,
    model: text(profile.model),
    modeId: text(profile.modeId),
    thinkingOptionId: text(profile.thinkingOptionId),
    ...(profile.featureValues === undefined ? {} : { featureValues: profile.featureValues }),
  };
}

/**
 * The gateway's resolved `route` as a target, or null when it names neither a usable
 * `provider/model` nor a known profile. Fields set beside a profile override it.
 */
export function routeTarget(
  route: { model?: unknown; mode?: unknown; thinking?: unknown; profile?: unknown },
  profiles: readonly ProfileLike[] = [],
): PresetTarget | null {
  const profileId = text(route.profile);
  const profile = profileId === '' ? undefined : profiles.find((p) => p.id === profileId);
  const parsed = text(route.model) === '' ? null : parsePresetModel(text(route.model));
  const base = profile === undefined ? null : profileTarget(profile);
  const target = parsed === null ? base : { modeId: '', ...base, ...parsed };
  if (target === null) {
    return null;
  }
  const modeId = text(route.mode);
  const thinking = text(route.thinking);
  return {
    ...target,
    ...(modeId === '' ? {} : { modeId }),
    ...(thinking === '' ? {} : { thinkingOptionId: thinking }),
  };
}

interface ConfigLike {
  readonly provider: string;
  readonly model?: string;
  readonly modeId?: string;
  readonly thinkingOptionId?: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly featureValues?: Record<string, unknown>;
}

/** The fields a target sets; empty ones keep what the agent (or the provider default) has. */
function targetFields(target: PresetTarget): Record<string, unknown> {
  const thinking = target.thinkingOptionId ?? '';
  return {
    ...(target.model === '' ? {} : { model: target.model }),
    ...(target.modeId === '' ? {} : { modeId: target.modeId }),
    ...(thinking === '' ? {} : { thinkingOptionId: thinking }),
    ...(target.featureValues === undefined ? {} : { featureValues: target.featureValues }),
  };
}

/**
 * Apply a preset to an agent config. Same provider: change model, and mode, thinking option and
 * feature values when the preset names them. Another provider: provider-specific fields are
 * dropped first so the new provider starts from its defaults.
 */
export function applyPreset<C extends ConfigLike>(config: C, target: PresetTarget): C {
  if (config.provider === target.provider) {
    return { ...config, ...targetFields(target) };
  }
  const {
    modeId: _mode,
    thinkingOptionId: _thinking,
    providerOptions: _options,
    featureValues: _features,
    model: _model,
    ...rest
  } = config;
  return { ...rest, provider: target.provider, ...targetFields(target) } as unknown as C;
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
        readonly thinkingOptions?:
          | readonly { readonly id: string; readonly label: string }[]
          | null
          | undefined;
        readonly defaultThinkingOptionId?: string | null | undefined;
      }[]
    | undefined;
}

export interface ThinkingChoices {
  readonly options: readonly ModelOption[];
  /** The model's own default, shown as the unset choice. */
  readonly defaultId: string;
}

/** `provider/model` → its thinking options, for models that have any. */
export function modelThinking(
  results: readonly ProviderModelsLike[],
): ReadonlyMap<string, ThinkingChoices> {
  const out = new Map<string, ThinkingChoices>();
  for (const result of results) {
    for (const model of result.models ?? []) {
      const options = model.thinkingOptions ?? [];
      if (options.length > 0) {
        out.set(`${result.provider}/${model.id}`, {
          options: options.map((o) => ({ label: o.label || o.id, value: o.id })),
          defaultId: model.defaultThinkingOptionId ?? '',
        });
      }
    }
  }
  return out;
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
