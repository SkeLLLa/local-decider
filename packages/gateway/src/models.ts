import type { ModelDescriptor } from './engines/descriptor.ts';
import { allModels, type EngineId } from './engines/registry.ts';

/** Share of physical memory a decision model may take; the rest stays for the user's work. */
export const MEMORY_BUDGET = 0.8;

export function catalogModel(id: string, engine?: EngineId): ModelDescriptor | undefined {
  return allModels().find(
    (model) => model.id === id && (engine === undefined || model.engine === engine),
  );
}

/** Memory a model needs on `device`: bf16 on an accelerator, fp32 (`memoryGb`) otherwise. */
export function modelMemoryGb(model: ModelDescriptor, device?: string | null): number | null {
  const accelerated = device === 'mlx' || device === 'mps' || device === 'cuda';
  return accelerated && model.gpuMemoryGb !== undefined ? model.gpuMemoryGb : model.memoryGb;
}

/** False when a known model's estimated memory exceeds the budget; unknown sizes pass. */
export function modelFits(
  id: string,
  totalBytes: number,
  device?: string | null,
  engine?: EngineId,
): boolean {
  const model = catalogModel(id, engine);
  const memoryGb = model === undefined ? null : modelMemoryGb(model, device);
  return memoryGb === null || memoryGb * 1e9 <= totalBytes * MEMORY_BUDGET;
}
