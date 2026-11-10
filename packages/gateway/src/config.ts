import { MODES } from '@local-decider/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { Paths } from './paths.ts';

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

export const configSchema = z.strictObject({
  host: z.string().default('127.0.0.1'),
  // 0 = any free port (tests).
  port: z.number().int().min(0).max(65_535).default(DEFAULT_PORT),
  engine: engineSchema.default({
    type: 'strands-decider',
    model: DEFAULT_MODEL,
    device: 'auto',
    maxBatch: 8,
    extraArgs: [],
    startTimeoutSeconds: 900,
  }),
  /** Per-policy overrides of the YAML `mode`. */
  policies: z.record(z.string(), z.strictObject({ mode: z.enum(MODES).optional() })).default({}),
  /** Extra policy directories, searched after the defaults; later ids replace earlier ones. */
  policyDirs: z.array(z.string()).default([]),
  /** `lazy`: load the model on the first decision, unload when idle. `eager`: keep it loaded. */
  lifecycle: z
    .strictObject({
      mode: z.enum(['lazy', 'eager']).default('lazy'),
      idleUnloadMinutes: z.number().int().min(1).max(1440).default(15),
    })
    .default({ mode: 'lazy', idleUnloadMinutes: 15 }),
  /** Tool paths; unset = automatic discovery. The settings page can override these (state.json). */
  tools: z
    .strictObject({
      flm: z.string().min(1).optional(),
      strandsDecider: z.string().min(1).optional(),
      uv: z.string().min(1).optional(),
    })
    .default({}),
  /** Model stores; unset = each tool's default (FLM_MODEL_PATH, HF_HUB_CACHE). */
  dirs: z
    .strictObject({
      flmModels: z.string().min(1).optional(),
      hfCache: z.string().min(1).optional(),
    })
    .default({}),
  /** Deadline for one decision, queue wait included. */
  decisionTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
});

export type GatewayConfig = z.infer<typeof configSchema>;
export type EngineConfig = GatewayConfig['engine'];
export type StrandsEngineConfig = z.infer<typeof strandsSchema>;
export type RemoteEngineConfig = z.infer<typeof remoteSchema>;
export type FlmEngineConfig = z.infer<typeof flmSchema>;

/** Defaults for an engine type, for switching to an engine the config does not describe. */
export function engineDefaults(type: 'strands-decider' | 'fastflowlm'): EngineConfig {
  return engineSchema.parse({ type });
}

function configFile(paths: Paths): string {
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
