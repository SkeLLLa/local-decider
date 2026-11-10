/** `GET /v1/policies` → a policy and the variants that can answer for it (e.g. routing). */
import { z } from 'zod';

const policyId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

const entrySchema = z.object({
  id: policyId,
  description: z.string().max(600).catch(''),
  routes: z.array(z.string().max(64)).max(255).catch([]),
  variant: policyId.optional().catch(undefined),
  variants: z.array(policyId).max(255).optional().catch(undefined),
});

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

/** Pick policy `id` and its variants out of the list; entries that fail to parse are skipped. */
export function parsePolicyVariants(body: unknown, id: string): PolicyVariants {
  const list = Array.isArray(body) ? body : [];
  const entries = new Map<string, z.output<typeof entrySchema>>();
  for (const item of list) {
    const parsed = entrySchema.safeParse(item);
    if (parsed.success) {
      entries.set(parsed.data.id, parsed.data);
    }
  }
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
