import { HARNESSES, MODES } from '@local-decider/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { Paths } from './paths.ts';
import { pricingSchema } from './savings.ts';

export const DEFAULT_PORT = 8765;
export const DEFAULT_MODEL = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
export const DEVICES = ['auto', 'cpu', 'mlx', 'mps', 'cuda'] as const;
export type Device = (typeof DEVICES)[number];

const strandsSchema = z.strictObject({
  type: z.literal('strands-decider'),
  model: z.string().min(1).default(DEFAULT_MODEL),
  device: z.enum(DEVICES).default('auto'),
  /** Attach to a running `strands-decider serve` instead of spawning one. */
  url: z.url().optional(),
  maxBatch: z.number().int().min(1).max(64).default(8),
  /** Extra `serve` flags, e.g. ["--no-warmup"]. Only flags; never derived from requests. */
  extraArgs: z
    .array(z.string().regex(/^--[a-z][a-z0-9-]*(?:=[\w./:-]+)?$|^[\w./:-]+$/))
    .default([]),
  startTimeoutSeconds: z.number().int().min(10).max(3600).default(900),
});

const remoteSchema = z.strictObject({
  type: z.literal('systemone-remote'),
  url: z.url(),
  model: z.string().default('remote'),
  /** Name of the environment variable holding a bearer token for the remote engine. */
  tokenEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
});

export const DEFAULT_FLM_MODEL = 'd3:nano';
const FLM_PMODES = ['powersaver', 'balanced', 'performance', 'turbo'] as const;

const flmSchema = z.strictObject({
  type: z.literal('fastflowlm'),
  /** A d3 decision-model tag served with `flm serve --decision <model>`. */
  model: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$/)
    .default(DEFAULT_FLM_MODEL),
  /** The `flm` launcher; default: the managed install (`local-decider engine install --engine fastflowlm`). */
  binary: z.string().min(1).optional(),
  /** Attach to a running `flm serve --decision` instead of spawning one. */
  url: z.url().optional(),
  pmode: z.enum(FLM_PMODES).default('performance'),
  startTimeoutSeconds: z.number().int().min(10).max(3600).default(300),
});

const engineSchema = z.discriminatedUnion('type', [strandsSchema, remoteSchema, flmSchema]);

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
  })
  .describe('Where one routing preset sends a task in one harness.');

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
    selection: z
      .strictObject({
        engine: z.enum(['strands-decider', 'fastflowlm']),
        model: z.string().min(1).max(300),
        device: z.enum(DEVICES).optional(),
      })
      .optional()
      .describe(
        'Engine and model in use, set by the settings pages; beats `engine.type` and `engine.model`.',
      ),
    policies: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]*$/), policySettingsSchema)
      .default({})
      .describe('Per-policy mode and variant, by policy id (e.g. `routing`).'),
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
    tools: z
      .strictObject({
        flm: z.string().min(1).optional(),
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
export type StrandsEngineConfig = z.infer<typeof strandsSchema>;
export type RemoteEngineConfig = z.infer<typeof remoteSchema>;
export type FlmEngineConfig = z.infer<typeof flmSchema>;

/** Defaults for an engine type, for switching to an engine the config does not describe. */
export function engineDefaults(type: 'strands-decider' | 'fastflowlm'): EngineConfig {
  return engineSchema.parse({ type });
}

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
