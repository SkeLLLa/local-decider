import type { EngineContext, ModelDescriptor } from '../descriptor.ts';
import { GGUF, ggufPath } from './models.ts';
import { recordMatches } from './verified.ts';

export async function llamaModelsPresent(
  models: readonly ModelDescriptor<'llama-vulkan'>[],
  ctx: EngineContext,
): Promise<ReadonlyMap<string, boolean>> {
  return new Map(
    models.map((model) => {
      const path = ggufPath(ctx.paths, model.id);
      const pin = GGUF[model.id];
      return [model.id, path !== undefined && pin !== undefined && recordMatches(path, pin.sha256)];
    }),
  );
}

export function hasVulkanDevice(output: string): boolean {
  return /^\s*Vulkan\d+:/m.test(output);
}
