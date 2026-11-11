import { tokenAllowed } from '@local-decider/core';

import type { GatewayConfig } from './config.ts';
import { getJson } from './engines/http.ts';

/** Engines that serve an OpenAI-style `/models` list and take their model from it. */
export const OPENAI_LIKE_ENGINES = ['openai-compatible', 'lmstudio'] as const;
export type OpenAILikeEngine = (typeof OPENAI_LIKE_ENGINES)[number];

const DISCOVERY_TIMEOUT_MS = 2000;
const DISCOVERY_MAX_BYTES = 256 * 1024;

export function isOpenAILike(id: string): id is OpenAILikeEngine {
  return (OPENAI_LIKE_ENGINES as readonly string[]).includes(id);
}

/** What discovery needs of an engine's config. */
export interface DiscoveryEndpoint {
  readonly url: string;
  readonly model: string;
  readonly tokenEnv?: string | undefined;
}

/**
 * The effective config of an OpenAI-like engine: the primary `engine:` block when it is this
 * engine, otherwise its `engines.<id>` options. Undefined while neither names a model.
 */
export function discoveryEndpoint(
  id: OpenAILikeEngine,
  config: GatewayConfig,
): DiscoveryEndpoint | undefined {
  const primary = config.engine;
  if (primary.type === id) {
    return primary;
  }
  return config.engines?.[id];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ids from an OpenAI-style `{data: [{id}]}` list; malformed or odd ids are dropped. */
export function parseModelIds(value: unknown): string[] {
  const data = isRecord(value) ? value['data'] : undefined;
  if (!Array.isArray(data)) {
    return [];
  }
  const ids = data.flatMap((entry) => {
    const id = validId(isRecord(entry) ? entry['id'] : undefined);
    return id === undefined ? [] : [id];
  });
  return [...new Set(ids)];
}

function validId(id: unknown): string | undefined {
  return typeof id === 'string' && id.length > 0 && id.length <= 300 && /^[^-\s][^\s]*$/.test(id)
    ? id
    : undefined;
}

/** A model from LM Studio's native `/api/v0/models`. */
export interface NativeModel {
  readonly id: string;
  /** `llm` and `vlm` are usable; `embeddings` (or anything else) is not. */
  readonly usable: boolean;
  readonly loaded: boolean;
  /** `MLX`, `GGUF`…; from `compatibility_type`. */
  readonly format?: string;
  /** The runtime, when the payload names one. */
  readonly runtime?: string;
}

function shortText(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._ ()+-]{1,40}$/.test(value) ? value : undefined;
}

/** Entries of `{data: [...]}` from `/api/v0/models`; first entry per id wins. */
export function parseNativeModels(value: unknown): NativeModel[] {
  const data = isRecord(value) ? value['data'] : undefined;
  if (!Array.isArray(data)) {
    return [];
  }
  const seen = new Set<string>();
  const out: NativeModel[] = [];
  for (const entry of data) {
    const id = validId(isRecord(entry) ? entry['id'] : undefined);
    if (id === undefined || seen.has(id) || !isRecord(entry)) {
      continue;
    }
    seen.add(id);
    const format = shortText(entry['compatibility_type']);
    const runtime = shortText(entry['runtime']);
    out.push({
      id,
      usable: entry['type'] === 'llm' || entry['type'] === 'vlm',
      loaded: entry['state'] === 'loaded',
      ...(format === undefined ? {} : { format: format.toUpperCase() }),
      ...(runtime === undefined ? {} : { runtime }),
    });
  }
  return out;
}

/** `http://host:1234/v1` -> `http://host:1234/api/v0/models`. */
export function nativeModelsUrl(url: string): string {
  return `${url.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/v0/models`;
}

function endpointKey(id: string, endpoint: DiscoveryEndpoint): string {
  return JSON.stringify([id, endpoint.url, endpoint.model, endpoint.tokenEnv ?? null]);
}

interface Discovered {
  readonly key: string;
  readonly models: readonly string[];
  /** `MLX`, `GGUF · runtime`…, by model id; only from LM Studio's native API. */
  readonly details: ReadonlyMap<string, string>;
}

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * Models found on each OpenAI-like engine's server. State is kept per engine and tied to the
 * endpoint config it was read with, so a changed url, model or token variable never shows the
 * previous server's models.
 */
export class ModelDiscovery {
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetch: typeof fetch | undefined;
  readonly #found = new Map<string, Discovered>();

  constructor(env: NodeJS.ProcessEnv, doFetch?: typeof fetch) {
    this.#env = env;
    this.#fetch = doFetch;
  }

  /** What the last refresh found for this exact endpoint config; empty when stale or unknown. */
  models(id: OpenAILikeEngine, endpoint: DiscoveryEndpoint | undefined): readonly string[] {
    const found = this.#found.get(id);
    return endpoint !== undefined && found?.key === endpointKey(id, endpoint) ? found.models : [];
  }

  /** Format and runtime of a discovered model (`MLX`, `GGUF · llama.cpp`), if the server said. */
  detail(
    id: OpenAILikeEngine,
    endpoint: DiscoveryEndpoint | undefined,
    model: string,
  ): string | undefined {
    const found = this.#found.get(id);
    return endpoint !== undefined && found?.key === endpointKey(id, endpoint)
      ? found.details.get(model)
      : undefined;
  }

  /** Ask the server for its models; falls back to the configured one when it cannot answer. */
  async refresh(id: OpenAILikeEngine, endpoint: DiscoveryEndpoint | undefined): Promise<void> {
    if (endpoint === undefined) {
      this.#found.delete(id);
      return;
    }
    const native = id === 'lmstudio' ? await this.#listNative(endpoint) : undefined;
    const found = native ?? { models: await this.#list(endpoint), details: NONE };
    this.#found.set(id, { key: endpointKey(id, endpoint), ...found });
  }

  #get(url: string, endpoint: DiscoveryEndpoint): Promise<unknown> {
    const token =
      endpoint.tokenEnv !== undefined && tokenAllowed(endpoint.url)
        ? this.#env[endpoint.tokenEnv]
        : undefined;
    return getJson(url, {
      token,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      maxBytes: DISCOVERY_MAX_BYTES,
      fetch: this.#fetch,
    });
  }

  /** LM Studio's `/api/v0/models`: loaded models first, embedding models never; undefined on failure. */
  async #listNative(
    endpoint: DiscoveryEndpoint,
  ): Promise<Pick<Discovered, 'models' | 'details'> | undefined> {
    let all: NativeModel[];
    try {
      all = parseNativeModels(await this.#get(nativeModelsUrl(endpoint.url), endpoint));
    } catch {
      return undefined;
    }
    const usable = all.filter((m) => m.usable);
    const ordered = [...usable.filter((m) => m.loaded), ...usable.filter((m) => !m.loaded)];
    const embedding = all.some((m) => !m.usable && m.id === endpoint.model);
    const ids = ordered.map((m) => m.id);
    const models = ids.includes(endpoint.model) || embedding ? ids : [endpoint.model, ...ids];
    const details = new Map<string, string>();
    for (const m of ordered) {
      const text = [m.format, m.runtime].filter((part) => part !== undefined).join(' · ');
      if (text !== '') {
        details.set(m.id, text);
      }
    }
    return { models, details };
  }

  async #list(endpoint: DiscoveryEndpoint): Promise<readonly string[]> {
    try {
      const response = await this.#get(`${endpoint.url.replace(/\/+$/, '')}/models`, endpoint);
      return [endpoint.model, ...parseModelIds(response).filter((id) => id !== endpoint.model)];
    } catch {
      return [endpoint.model];
    }
  }
}
