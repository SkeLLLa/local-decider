import { z } from 'zod';

import { DEVICES, defineEngine } from '../descriptor.ts';
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

export const strandsEngine = defineEngine({
  id: 'strands-decider',
  label: 'Strands Decider',
  description: 'strands-decider decision engine',
  configSchema: strandsSchema,
  selectable: true,
  supports: () => ({ ok: true }),
  tag: () => 'PyTorch',
  devices: () => DEVICES,
  calibrated: true,
  create: (config, ctx) => new StrandsDeciderEngine(config, ctx.paths, ctx.tools),
});
