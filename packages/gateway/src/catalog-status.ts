import type { EngineContext, ModelDescriptor, Validation } from './engines/descriptor.ts';
import { engineDescriptor, type EngineId } from './engines/registry.ts';

export type { Validation } from './engines/descriptor.ts';

const CACHE_TTL_MS = 15_000;
const VALIDATION_TTL_MS = 60_000;

interface CacheEntry<T> {
  readonly at: number;
  readonly value: T;
}

function fresh<T>(entry: CacheEntry<T> | undefined, ttl: number): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.at < ttl;
}

class EngineCache<T> {
  readonly #values = new Map<EngineId, CacheEntry<T>>();
  readonly #loads = new Map<EngineId, Promise<T>>();

  read(engine: EngineId): T | undefined {
    return this.#values.get(engine)?.value;
  }

  clear(engine?: EngineId): void {
    if (engine === undefined) {
      this.#values.clear();
      this.#loads.clear();
    } else {
      this.#values.delete(engine);
      this.#loads.delete(engine);
    }
  }

  async get(engine: EngineId, ttl: number, load: () => Promise<T>): Promise<T> {
    const entry = this.#values.get(engine);
    if (fresh(entry, ttl)) {
      return entry.value;
    }
    const pending = this.#loads.get(engine);
    if (pending !== undefined) {
      return pending;
    }
    const promise = Promise.resolve().then(load);
    this.#loads.set(engine, promise);
    try {
      const value = await promise;
      if (this.#loads.get(engine) === promise) {
        this.#values.set(engine, { at: Date.now(), value });
      }
      return value;
    } finally {
      if (this.#loads.get(engine) === promise) {
        this.#loads.delete(engine);
      }
    }
  }
}

function modelsByEngine(
  models: readonly ModelDescriptor[],
): Map<EngineId, ModelDescriptor<EngineId>[]> {
  const groups = new Map<EngineId, ModelDescriptor<EngineId>[]>();
  for (const model of models) {
    const engine = model.engine as EngineId;
    const group = groups.get(engine) ?? [];
    group.push(model as ModelDescriptor<EngineId>);
    groups.set(engine, group);
  }
  return groups;
}

function modelPresence(
  models: readonly ModelDescriptor[],
  value: boolean,
): ReadonlyMap<string, boolean> {
  return new Map(models.map((model) => [model.id, value]));
}

async function checkModels(
  engine: EngineId,
  models: readonly ModelDescriptor<EngineId>[],
  context: EngineContext,
): Promise<ReadonlyMap<string, boolean>> {
  const descriptor = engineDescriptor(engine);
  if (descriptor === undefined) {
    return modelPresence(models, false);
  }
  const check = descriptor.modelsPresent as
    | ((
        this: void,
        models: readonly ModelDescriptor[],
        ctx: EngineContext,
      ) => Promise<ReadonlyMap<string, boolean>>)
    | undefined;
  if (check === undefined) {
    return modelPresence(models, true);
  }
  try {
    return await check(models, context);
  } catch {
    return modelPresence(models, false);
  }
}

function failedValidation(
  engine: EngineId,
  message = `${engine} does not support validation`,
): Validation {
  const detail = message || `${engine} validation failed`;
  return { ok: false, checkedAt: new Date().toISOString(), summary: detail, lines: [detail] };
}

async function runValidation(engine: EngineId, context: EngineContext): Promise<Validation> {
  const validation = engineDescriptor(engine)?.validation;
  if (validation === undefined) {
    return failedValidation(engine);
  }
  try {
    return await validation.run(context);
  } catch (error) {
    return failedValidation(engine, error instanceof Error ? error.message : String(error));
  }
}

/** Per-engine presence and validation caches; engine-specific checks live on descriptors. */
export class CatalogStatus {
  #context: EngineContext;
  readonly #models = new EngineCache<ReadonlyMap<string, boolean>>();
  readonly #validations = new EngineCache<Validation>();

  constructor(context: EngineContext) {
    this.#context = context;
  }

  /** A new toolchain or path invalidates all values derived from the previous context. */
  reset(context: EngineContext): void {
    this.#context = context;
    this.#models.clear();
    this.#validations.clear();
  }

  invalidate(engine?: EngineId): void {
    this.#models.clear(engine);
  }

  get validation(): Validation | undefined {
    return this.getValidation('fastflowlm');
  }

  getValidation(engine: EngineId): Validation | undefined {
    return this.#validations.read(engine);
  }

  async installed(models: readonly ModelDescriptor[]): Promise<Map<string, boolean>> {
    const groups = modelsByEngine(models);
    const values = await Promise.all(
      [...groups].map(([engine, engineModels]) =>
        this.#models.get(engine, CACHE_TTL_MS, () =>
          checkModels(engine, engineModels, this.#context),
        ),
      ),
    );
    return new Map(values.flatMap((presence) => [...presence]));
  }

  validate(engine: EngineId): Promise<Validation> {
    return this.#validations.get(engine, VALIDATION_TTL_MS, () =>
      runValidation(engine, this.#context),
    );
  }
}
