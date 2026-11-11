import { z } from 'zod';

import type { EngineContext, EngineDescriptor, ModelDescriptor } from './descriptor.ts';
import { fastflowlmEngine } from './fastflowlm/index.ts';
import { remoteEngine } from './remote.ts';
import { strandsEngine } from './strands/index.ts';
import type { Engine } from './types.ts';

export const ENGINES = [strandsEngine, remoteEngine, fastflowlmEngine] as const;
const ENGINE_BY_ID = new Map<string, AnyEngine>(
  ENGINES.map((engine): [string, AnyEngine] => [engine.id, engine]),
);

export type AnyEngine = (typeof ENGINES)[number];
export type EngineId = AnyEngine['id'];
export type SelectableEngineId = Extract<AnyEngine, { readonly selectable: true }>['id'];
export type EngineConfig = z.output<AnyEngine['configSchema']>;

type Schemas<T extends readonly unknown[]> = {
  [K in keyof T]: T[K] extends EngineDescriptor<infer _C, infer S> ? S : never;
};

export const engineSchema = z.discriminatedUnion(
  'type',
  ENGINES.map((engine) => engine.configSchema) as unknown as Schemas<typeof ENGINES>,
);

export function allModels(engines: readonly AnyEngine[] = ENGINES): ModelDescriptor<EngineId>[] {
  const models: ModelDescriptor<EngineId>[] = [];
  for (const engine of engines) {
    models.push(...engine.models);
  }
  return models;
}

export const SELECTABLE_IDS = ENGINES.filter((engine) => engine.selectable).map(
  (engine) => engine.id,
) as [SelectableEngineId, ...SelectableEngineId[]];
const selectableEngineSchema = z.enum(SELECTABLE_IDS);

export function engineDescriptor(id: string): AnyEngine | undefined {
  return ENGINE_BY_ID.get(id);
}

export function isSelectableEngine(id: unknown): id is SelectableEngineId {
  return selectableEngineSchema.safeParse(id).success;
}

export function engineDefaults(id: EngineId, model?: string, options: object = {}): EngineConfig {
  const descriptor = engineDescriptor(id);
  if (descriptor === undefined) {
    throw new Error(`unknown engine: ${id}`);
  }
  const input = { ...options, type: id, ...(model === undefined ? {} : { model }) };
  return descriptor.configSchema.parse(input);
}

export function createEngine(config: EngineConfig, ctx: EngineContext): Engine {
  const descriptor = engineDescriptor(config.type);
  if (descriptor === undefined) {
    throw new Error(`unknown engine: ${config.type}`);
  }
  const typedDescriptor = descriptor as unknown as EngineDescriptor<EngineConfig>;
  return typedDescriptor.create(config, ctx);
}
