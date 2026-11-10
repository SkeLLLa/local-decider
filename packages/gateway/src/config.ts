import { MODES } from '@local-decider/core';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { Paths } from './paths.ts';

export const DEFAULT_PORT = 8765;
export const DEFAULT_MODEL = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';

const strandsSchema = z.strictObject({
  type: z.literal('strands-decider'),
  model: z.string().min(1).default(DEFAULT_MODEL),
  device: z.enum(['auto', 'cpu', 'mlx', 'mps', 'cuda']).default('auto'),
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

const engineSchema = z.discriminatedUnion('type', [strandsSchema, remoteSchema]);

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
  /** Deadline for one decision, queue wait included. */
  decisionTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
});

export type GatewayConfig = z.infer<typeof configSchema>;
export type EngineConfig = GatewayConfig['engine'];
export type StrandsEngineConfig = z.infer<typeof strandsSchema>;
export type RemoteEngineConfig = z.infer<typeof remoteSchema>;

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
