/**
 * `GET /v1/policies` → a policy and the variants that can answer for it (e.g. routing), and the
 * rule thresholds of the one answering.
 */
import { z } from 'zod';

import { ALLOW_THRESHOLD } from './constants.ts';

const policyId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

const thresholdSchema = z.object({
  /** `<question>.<answer>`, the key config.yaml `policies.<id>.thresholds` uses. */
  key: z.string().min(3).max(200),
  question: z.string().max(64),
  answer: z.string().max(200),
  action: z.string().max(100),
  kind: z.enum(['minProbability', 'minConfidence']),
  /** The policy file's value; null when the rule has none. */
  default: z.number().min(0).max(1).nullable(),
  value: z.number().min(0).max(1).nullable(),
  /** Lowest value the gateway accepts (0.5 for allow rules); older gateways send none. */
  floor: z.number().min(0).max(1).catch(0),
});
export type ThresholdSetting = z.output<typeof thresholdSchema>;

const entrySchema = z.object({
  id: policyId,
  description: z.string().max(600).catch(''),
  routes: z.array(z.string().max(64)).max(255).catch([]),
  variant: policyId.optional().catch(undefined),
  variants: z.array(policyId).max(255).optional().catch(undefined),
  /** Older gateways have none. */
  thresholds: z.array(thresholdSchema).max(255).catch([]),
});
type Entry = z.output<typeof entrySchema>;

const policyVariantSchema = z.object({
  id: policyId,
  description: z.string(),
  routes: z.array(z.string()),
});

export const policyVariantsSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  /** Variant answering now; null when the gateway is down or does not know the policy. */
  active: policyId.nullable(),
  variants: z.array(policyVariantSchema),
});
export type PolicyVariants = z.output<typeof policyVariantsSchema>;

function parseEntries(list: readonly unknown[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  for (const item of list) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success) {
      entries.set(parsed.data.id, parsed.data);
    }
  }
  return entries;
}

/** Pick policy `id` and its variants out of the list; entries that fail to parse are skipped. */
export function parsePolicyVariants(body: unknown, id: string): PolicyVariants {
  const list = Array.isArray(body) ? body : [];
  const entries = parseEntries(list);
  const base = entries.get(id);
  if (base === undefined) {
    return {
      ok: false,
      error: list.length === 0 ? 'The gateway did not list its policies.' : `No "${id}" policy.`,
      active: null,
      variants: [],
    };
  }
  const variants = (base.variants ?? [id]).flatMap((variant) => {
    const entry = entries.get(variant);
    return entry === undefined
      ? []
      : [{ id: entry.id, description: entry.description, routes: entry.routes }];
  });
  return { ok: true, error: null, active: base.variant ?? id, variants };
}

export const policyThresholdsSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  /** The policy whose rules answer for the hook policy now (a variant, or the policy itself). */
  policy: policyId.nullable(),
  thresholds: z.array(thresholdSchema),
});
export type PolicyThresholds = z.output<typeof policyThresholdsSchema>;

/** The rule thresholds in effect for hook policy `id`: those of the variant answering for it. */
export function parsePolicyThresholds(body: unknown, id: string): PolicyThresholds {
  const entries = parseEntries(Array.isArray(body) ? body : []);
  const base = entries.get(id);
  const answering = entries.get(base?.variant ?? id) ?? base;
  if (answering === undefined) {
    return { ok: false, error: `No "${id}" policy.`, policy: null, thresholds: [] };
  }
  return { ok: true, error: null, policy: answering.id, thresholds: answering.thresholds };
}

const ACTION_VERBS: Readonly<Record<string, string>> = { allow: 'auto-allow' };

/** `auto-allow when verdict is allow`, `route to fast when tier is fast`. */
export function thresholdLabel(t: ThresholdSetting): string {
  const verb = t.action.startsWith('route:')
    ? `route to ${t.action.slice('route:'.length)}`
    : (ACTION_VERBS[t.action] ?? t.action);
  return `${verb} when ${t.question} is ${t.answer}`;
}

/** `p(allow) ≥ 0.95`, `confidence ≥ 0.8`, with the default when it is overridden. */
export function thresholdText(t: ThresholdSetting): string {
  const subject = t.kind === 'minProbability' ? `p(${t.answer})` : 'confidence';
  const value = t.value === null ? 'any' : t.value.toFixed(2);
  const overridden = t.value !== t.default;
  const base = t.default === null ? 'none' : t.default.toFixed(2);
  return `${subject} ≥ ${value}${overridden ? ` (default ${base})` : ''}`;
}

/** Slider and input resolution: hundredths. */
export const THRESHOLD_STEP = 0.01;

/** Lowest value the rule accepts: the gateway's floor, and never below 0.5 for an auto-allow. */
export function thresholdFloor(t: ThresholdSetting): number {
  return t.action === 'allow' ? Math.max(t.floor, ALLOW_THRESHOLD.floor) : t.floor;
}

/** `value` snapped to hundredths within the rule's floor..1. */
export function clampThreshold(t: ThresholdSetting, value: number): number {
  const floor = thresholdFloor(t);
  const rounded = Math.round(Math.min(1, Math.max(floor, value)) * 100) / 100;
  return Math.min(1, Math.max(floor, rounded));
}

/**
 * A typed threshold: `0.9`, `.9`, `90` or `90%` (a percentage when above 1). Out-of-range and
 * unparsable text is an error, never silently clamped.
 */
export function parseThresholdInput(
  t: ThresholdSetting,
  text: string,
): { value: number; error: null } | { value: null; error: string } {
  const trimmed = text.trim().replace(/%$/, '').replace(',', '.');
  const raw = /^\d*\.?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const value = raw > 1 || text.trim().endsWith('%') ? raw / 100 : raw;
  const floor = thresholdFloor(t);
  if (!Number.isFinite(value) || value < floor || value > 1) {
    return { value: null, error: `Enter a number from ${floor.toFixed(2)} to 1.00.` };
  }
  return { value: clampThreshold(t, value), error: null };
}

/** How risky an auto-allow threshold of `value` is; null for other rules and safe values. */
export function allowWarning(
  t: ThresholdSetting,
  value: number | null = t.value,
): { strong: boolean; text: string } | null {
  if (t.action !== 'allow' || value === null || value >= ALLOW_THRESHOLD.soft) {
    return null;
  }
  return value < ALLOW_THRESHOLD.strong
    ? { strong: true, text: 'The local model will often auto-allow requests it is unsure about.' }
    : { strong: false, text: 'More requests will be auto-allowed without asking you.' };
}

/** Track bands the slider tints for an auto-allow rule: strong warning, then soft warning. */
export function warningZones(t: ThresholdSetting): { from: number; to: number; strong: boolean }[] {
  if (t.action !== 'allow') {
    return [];
  }
  const floor = thresholdFloor(t);
  const softFrom = Math.max(floor, ALLOW_THRESHOLD.strong);
  return [
    { from: floor, to: ALLOW_THRESHOLD.strong, strong: true },
    { from: softFrom, to: ALLOW_THRESHOLD.soft, strong: false },
  ].filter((zone) => zone.to > zone.from);
}

/**
 * Preset rows to show: the active variant's routes in policy order, then presets that still have
 * a saved mapping but that variant never picks.
 */
export function presetRows(
  routes: readonly string[],
  saved: Readonly<
    Record<string, { readonly model?: string | undefined; readonly profile?: string | undefined }>
  >,
): { name: string; used: boolean }[] {
  const extra = Object.entries(saved)
    .filter(
      ([name, setting]) =>
        ((setting.model ?? '') !== '' || setting.profile !== undefined) && !routes.includes(name),
    )
    .map(([name]) => name)
    .toSorted();
  return [
    ...routes.map((name) => ({ name, used: true })),
    ...extra.map((name) => ({ name, used: false })),
  ];
}

const presetTargetSchema = z.object({
  model: z.string().max(300).optional(),
  mode: z.string().max(200).optional(),
  thinking: z.string().max(100).optional(),
  profile: z.string().max(200).optional(),
});
export type PresetTargetSetting = z.output<typeof presetTargetSchema>;

export const routingSettingsSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  /** config.yaml on the gateway's machine; null when unknown. */
  file: z.string().nullable(),
  /** Paseo's preset → `provider/model` (and mode) from `routing.presets.paseo`. */
  presets: z.record(z.string(), presetTargetSchema),
});
export type RoutingSettings = z.output<typeof routingSettingsSchema>;

const configBodySchema = z.object({
  file: z.string().max(1000).nullable().catch(null),
  config: z.object({
    routing: z
      .object({
        presets: z
          .object({ paseo: z.record(z.string().max(64), presetTargetSchema).optional() })
          .catch({}),
      })
      .catch({ presets: {} }),
  }),
});

/** `GET /v1/config` → where config.yaml is and Paseo's preset targets. */
export function parseRoutingSettings(body: unknown): RoutingSettings {
  const parsed = configBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'The gateway did not return its settings (is it older than this plugin?).',
      file: null,
      presets: {},
    };
  }
  return {
    ok: true,
    error: null,
    file: parsed.data.file,
    presets: parsed.data.config.routing.presets.paseo ?? {},
  };
}

export const policyPromptSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  prompt: z.string(),
  /** Directory the authoring agent works in (the gateway's config dir). */
  cwd: z.string(),
});
export type PolicyPrompt = z.output<typeof policyPromptSchema>;

const promptBodySchema = z.object({
  prompt: z.string().min(1).max(200_000),
  cwd: z.string().min(1).max(1000),
});

export function parsePolicyPrompt(body: unknown): PolicyPrompt {
  const parsed = promptBodySchema.safeParse(body);
  return parsed.success
    ? { ok: true, error: null, ...parsed.data }
    : {
        ok: false,
        error: 'The gateway has no authoring prompt for this policy.',
        prompt: '',
        cwd: '',
      };
}

/**
 * Presets mapped in this host's plugin settings (before config.yaml held them) that config.yaml
 * does not have yet: the edits that move them to the gateway.
 */
export function legacyPresetMoves(
  saved: Readonly<Record<string, { readonly model: string; readonly modeId: string }>>,
  gateway: Readonly<Record<string, unknown>>,
): { preset: string; model: string; mode?: string }[] {
  return Object.entries(saved)
    .filter(([preset, setting]) => setting.model.trim() !== '' && !Object.hasOwn(gateway, preset))
    .map(([preset, setting]) => ({
      preset,
      model: setting.model.trim(),
      ...(setting.modeId.trim() === '' ? {} : { mode: setting.modeId.trim() }),
    }));
}
