import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { EngineContext, HostInfo } from '../descriptor.ts';
import { defineEngine } from '../descriptor.ts';
import { GGUF, LLAMA_MODEL_IDS, LLAMA_MODELS } from './models.ts';
import { LlamaVulkanEngine } from './server.ts';
import { llamaModelsPresent } from './status.ts';
import { llamaServerVersion } from './version.ts';

export const DEFAULT_LLAMA_MODEL = 'd3-mini-q4_k_m';

export const llamaVulkanSchema = z.strictObject({
  type: z.literal('llama-vulkan'),
  model: z.enum(LLAMA_MODEL_IDS).default(DEFAULT_LLAMA_MODEL),
  binary: z.string().min(1).optional(),
  url: z.url().optional(),
  ctxSize: z.number().int().min(512).max(16384).default(4096),
  gpuLayers: z.union([z.enum(['all', 'auto']), z.number().int().min(0).max(999)]).default('all'),
  vulkanDevice: z
    .string()
    .regex(/^Vulkan\d{1,2}$/)
    .optional(),
  startTimeoutSeconds: z.number().int().min(10).max(3600).default(300),
});

export type LlamaVulkanEngineConfig = z.infer<typeof llamaVulkanSchema>;

function supports(
  host: HostInfo,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  return host.platform === 'linux' && host.arch === 'x64'
    ? { ok: true }
    : { ok: false, reason: 'llama.cpp Vulkan builds are pinned for Linux x86_64 only' };
}

function validCondition(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]+$/.test(value);
}

function conditionAt(
  args: readonly string[],
  index: number,
): { value: string; consumed: number } | undefined {
  const arg = args[index];
  if (arg === undefined) return undefined;
  const equals = arg.startsWith('--conditions=')
    ? arg.slice(13)
    : arg.startsWith('-C=')
      ? arg.slice(3)
      : undefined;
  if (equals !== undefined)
    return validCondition(equals) ? { value: equals, consumed: 0 } : undefined;
  if (arg !== '--conditions' && arg !== '-C') return undefined;
  const value = args[index + 1];
  return validCondition(value)
    ? { value, consumed: 1 }
    : { value: '', consumed: value === undefined ? 0 : 1 };
}

export function forwardedConditions(execArgv: readonly string[]): string[] {
  const conditions: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const condition = conditionAt(execArgv, index);
    if (condition === undefined) continue;
    if (condition.value !== '') conditions.push(`--conditions=${condition.value}`);
    index += condition.consumed;
  }
  return conditions;
}

function cliPath(): string {
  const path = import.meta.url.endsWith('.ts') ? '../../cli.ts' : '../../cli.js';
  return fileURLToPath(new URL(path, import.meta.url));
}

function downloadCommand(modelId: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      ...forwardedConditions(process.execArgv),
      cliPath(),
      'engine',
      'install',
      '--engine',
      'llama-vulkan',
      '--model',
      modelId,
    ],
  };
}

export const llamaVulkanEngine = defineEngine({
  id: 'llama-vulkan',
  label: 'llama.cpp (Vulkan GPU)',
  description: 'llama.cpp llama-server (Vulkan backend) serving d3 decision models on the GPU',
  configSchema: llamaVulkanSchema,
  selectable: true,
  supports,
  tag: () => 'Vulkan',
  devices: () => [],
  calibrated: true,
  models: LLAMA_MODELS,
  runtimeStamp: async (model, ctx) => ({
    runtime: await llamaServerVersion(ctx.tools?.llamaServer),
    model: GGUF[model.id]?.sha256 ?? null,
  }),
  modelsPresent: llamaModelsPresent,
  downloadSteps: (model, ctx: EngineContext) => {
    if (!supports(ctx.host).ok) throw new Error('llama-vulkan is only available on Linux x86_64');
    return [downloadCommand(model.id)];
  },
  create: (config, ctx) => new LlamaVulkanEngine(config, ctx.paths, ctx.tools),
});
