// fallow-ignore-file duplicate-export -- Keep GatewayConfig and the registry's public EngineConfig type.
import { HARNESSES, MODES, SCOPES } from '@ziptie-soft/local-decider-core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { DEVICES } from './engines/descriptor.ts';
import { DEFAULT_FLM_MODEL } from './engines/fastflowlm/index.ts';
import { engineOptionsSchema, engineSchema, SELECTABLE_IDS } from './engines/registry.ts';
import { DEFAULT_MODEL } from './engines/strands/index.ts';
import type { Paths } from './paths.ts';
import { pricingSchema } from './savings.ts';

export const DEFAULT_PORT = 8765;

export { DEFAULT_FLM_MODEL, DEFAULT_MODEL };
export { DEVICES, type Device } from './engines/descriptor.ts';
export type { FlmEngineConfig } from './engines/fastflowlm/index.ts';
export type { RemoteEngineConfig } from './engines/remote.ts';
export type { StrandsEngineConfig } from './engines/strands/index.ts';
export { engineDefaults } from './engines/registry.ts';

/** A routing preset name, as in a policy's `route:<preset>` action. */
const presetName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/);

const presetTargetSchema = z
  .strictObject({
    model: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe(
        'Model the harness switches to or is told about. Paseo: `provider/model` (e.g. `claude/haiku`); Claude Code: `haiku`, `sonnet`, `opus` or a full id; Codex: a model id.',
      ),
    mode: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Paseo only: provider mode id for the new agent; unset keeps the provider default.',
      ),
    thinking: z
      .string()
      .max(100)
      .optional()
      .describe(
        'Thinking or reasoning level, e.g. `low`, `high`, `xhigh`, `max` (Paseo: the thinking option id of the model). Paseo applies it; Claude Code and Codex hints name it.',
      ),
    profile: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Paseo only: id of a Paseo agent profile (provider, model, mode, thinking, features). Fields set here override the profile.',
      ),
  })
  .refine((t) => t.model !== undefined || t.profile !== undefined, {
    message: 'a preset target needs a model or a profile',
  })
  .describe('Where one routing preset sends a task in one harness.');

export type PresetTarget = z.infer<typeof presetTargetSchema>;

const routingSchema = z
  .strictObject({
    presets: z
      .partialRecord(z.enum(HARNESSES), z.record(presetName, presetTargetSchema))
      .default({})
      .describe(
        'Harness id → preset name → target. Preset names come from the routing policy in use (`local-decider policies`). A preset without a target changes nothing.',
      ),
  })
  .default({ presets: {} })
  .describe('How each harness applies `route:<preset>` decisions.');

const policySettingsSchema = z
  .strictObject({
    mode: z
      .enum(MODES)
      .optional()
      .describe(
        'off: never asked; shadow: logged only; act: adapters may enforce. Unset: the policy file decides.',
      ),
    variant: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .optional()
      .describe(
        'Id of a policy with `variantOf: <this policy>` that answers instead of it. Unset: the policy itself.',
      ),
    scopes: z
      .partialRecord(
        z.enum(SCOPES),
        z.strictObject({
          mode: z
            .enum(MODES)
            .optional()
            .describe(
              'Mode cap for requests carrying this scope: they run at the lower of the policy mode and this one (off < shadow < act). Unset: shadow.',
            ),
        }),
      )
      .optional()
      .describe(
        'Per-scope settings, by scope (`claude-auto`: the Claude Code auto-mode mod). A scoped request never runs above its scope mode.',
      ),
    thresholds: z
      .record(
        z
          .string()
          .max(200)
          .regex(/^[a-z][a-z0-9_-]*\..+$/),
        z.number().min(0).max(1),
      )
      .optional()
      .describe(
        "Rule thresholds by `<question>.<answer>` (e.g. `verdict.allow: 0.9`), 0..1. Each replaces the `minProbability` of the policy rules with that question and answer, else their `minConfidence`. Applies to this policy file's own rules, so set a variant's thresholds under the variant's id. Unset: the policy file decides.",
      ),
  })
  .describe('Settings for one policy, by policy id.');

export const configSchema = z
  .strictObject({
    $schema: z.string().optional().describe('Optional JSON Schema reference for editors.'),
    host: z
      .string()
      .default('127.0.0.1')
      .describe(
        'Listen address. Anything but loopback needs LOCAL_DECIDER_TOKEN. Restart to apply.',
      ),
    // 0 = any free port (tests).
    port: z
      .number()
      .int()
      .min(0)
      .max(65_535)
      .default(DEFAULT_PORT)
      .describe('Listen port. Restart to apply.'),
    engine: engineSchema
      .default({
        type: 'strands-decider',
        model: DEFAULT_MODEL,
        device: 'auto',
        maxBatch: 8,
        extraArgs: [],
        startTimeoutSeconds: 900,
      })
      .describe(
        'The decision-model engine and its options. `selection` picks engine and model at runtime.',
      ),
    engines: engineOptionsSchema.optional().describe('Per-engine options for switching engines.'),
    selection: z
      .strictObject({
        mode: z
          .enum(['manual', 'auto'])
          .optional()
          .describe(
            '`auto` lets the gateway rank installed engines and fall back on failure; absent or `manual` keeps the engine and model below.',
          ),
        engine: z.enum(SELECTABLE_IDS).optional(),
        model: z.string().min(1).max(300).optional(),
        device: z.enum(DEVICES).optional(),
        family: z
          .string()
          .min(1)
          .max(400)
          .optional()
          .describe('Preferred model family for automatic selection.'),
      })
      .refine((s) => s.mode === 'auto' || (s.engine !== undefined && s.model !== undefined), {
        message: 'a manual selection needs `engine` and `model`',
      })
      .optional()
      .describe(
        'Engine and model in use, set by the settings pages; beats `engine.type` and `engine.model`. `mode: auto` selects automatically.',
      ),
    policies: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]*$/), policySettingsSchema)
      .default({})
      .describe('Per-policy mode, variant and rule thresholds, by policy id (e.g. `routing`).'),
    policyDirs: z
      .array(z.string())
      .default([])
      .describe(
        'Extra policy directories, read after the defaults and before `<config dir>/policies`; a later id replaces an earlier one.',
      ),
    routing: routingSchema,
    lifecycle: z
      .strictObject({
        mode: z.enum(['lazy', 'eager']).default('lazy'),
        idleUnloadMinutes: z.number().int().min(1).max(1440).default(15),
      })
      .default({ mode: 'lazy', idleUnloadMinutes: 15 })
      .describe(
        'lazy: load the model on the first decision and unload it when idle; eager: keep it loaded.',
      ),
    logs: z
      .strictObject({
        retainDays: z.number().int().min(90).max(3650).default(365),
      })
      .default({ retainDays: 365 })
      .describe('Decision log retention.'),
    tools: z
      .strictObject({
        flm: z.string().min(1).optional(),
        llamaServer: z.string().min(1).optional(),
        strandsDecider: z.string().min(1).optional(),
        uv: z.string().min(1).optional(),
      })
      .default({})
      .describe('Absolute tool paths; unset = automatic discovery.'),
    dirs: z
      .strictObject({
        flmModels: z.string().min(1).optional(),
        hfCache: z.string().min(1).optional(),
      })
      .default({})
      .describe("Model stores; unset = each tool's default (FLM_MODEL_PATH, HF_HUB_CACHE)."),
    /**
     * Optional price table, USD per million tokens, keyed by `provider/model` or a bare model id.
     * Unset: savings are reported in tokens only. Never fetched; you keep it current.
     */
    pricing: pricingSchema
      .optional()
      .describe(
        'USD per million tokens by `provider/model` or model id, for savings stats. Never fetched.',
      ),
    decisionTimeoutMs: z
      .number()
      .int()
      .min(100)
      .max(120_000)
      .default(30_000)
      .describe('Deadline for one decision, queue wait included.'),
  })
  .describe(
    'local-decider gateway settings (config.yaml). The gateway reloads this file when it changes.',
  );

export type GatewayConfig = z.infer<typeof configSchema>;
export type EngineConfig = GatewayConfig['engine'];

export function configFile(paths: Paths): string {
  return join(paths.config, 'config.yaml');
}

export function parseConfig(raw: unknown): GatewayConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`invalid config\n${issues.join('\n')}`);
  }
  return result.data;
}

/** Load `config.yaml` (missing file = defaults), then the user policy dir. */
export function loadConfig(paths: Paths, file: string = configFile(paths)): GatewayConfig {
  const raw: unknown = existsSync(file) ? parseYaml(readFileSync(file, 'utf8')) : {};
  const config = parseConfig(raw);
  const userPolicies = join(paths.config, 'policies');
  return existsSync(userPolicies) && !config.policyDirs.includes(userPolicies)
    ? { ...config, policyDirs: [...config.policyDirs, userPolicies] }
    : config;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}
