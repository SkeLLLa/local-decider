import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { DEVICES, defineEngine, type EngineContext, type ModelDescriptor } from '../descriptor.ts';
import { MODELS } from './models.ts';
import { StrandsDeciderEngine } from './server.ts';

export const DEFAULT_MODEL = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';

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

export type StrandsEngineConfig = z.infer<typeof strandsSchema>;

/** `models--Org--Name/snapshots/<rev>` holds at least one file. */
export function hfCached(hfCache: string, repo: string): boolean {
  const snapshots = join(hfCache, `models--${repo.replace('/', '--')}`, 'snapshots');
  if (!existsSync(snapshots)) {
    return false;
  }
  return readdirSync(snapshots).some((rev) => readdirSync(join(snapshots, rev)).length > 0);
}

function hfCachePath(ctx: EngineContext): string {
  const configured = ctx.tools?.env['HF_HUB_CACHE'] ?? ctx.env['HF_HUB_CACHE'];
  return configured ?? join(ctx.env['HF_HOME'] ?? join(homedir(), '.cache', 'huggingface'), 'hub');
}

function strandsModelsPresent(
  models: readonly ModelDescriptor<'strands-decider'>[],
  ctx: EngineContext,
): Promise<ReadonlyMap<string, boolean>> {
  const cache = hfCachePath(ctx);
  return Promise.resolve(
    new Map(
      models.map((model) => [
        model.id,
        (model.artifacts ?? []).every((artifact) => hfCached(cache, artifact)),
      ]),
    ),
  );
}

function strandsDownloadSteps(
  model: ModelDescriptor<'strands-decider'>,
  ctx: EngineContext,
): { readonly command: string; readonly args: readonly string[] }[] {
  const binary = ctx.tools?.strandsDecider;
  const hf = binary === undefined ? undefined : join(dirname(binary), 'hf');
  if (hf === undefined || !existsSync(hf)) {
    throw new Error(
      'the strands-decider engine is not installed; run `local-decider engine install`',
    );
  }
  return (model.artifacts ?? []).map((artifact) => ({ command: hf, args: ['download', artifact] }));
}

export const strandsEngine = defineEngine({
  id: 'strands-decider',
  label: 'Strands Decider (PyTorch)',
  description: 'strands-decider decision engine',
  configSchema: strandsSchema,
  selectable: true,
  supports: () => ({ ok: true }),
  tag: () => 'PyTorch',
  devices: (host) => {
    if (host.platform === 'darwin' && host.arch === 'arm64') {
      return ['auto', 'cpu', 'mlx', 'mps'];
    }
    if (host.platform === 'linux') {
      return ['auto', 'cpu', 'cuda'];
    }
    return ['auto', 'cpu'];
  },
  calibrated: true,
  models: MODELS,
  modelsPresent: strandsModelsPresent,
  downloadSteps: strandsDownloadSteps,
  create: (config, ctx) => new StrandsDeciderEngine(config, ctx.paths, ctx.tools, ctx.host),
});
