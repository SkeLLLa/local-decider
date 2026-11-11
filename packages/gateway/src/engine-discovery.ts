import { tokenAllowed } from '@local-decider/core';

import type { GatewayConfig } from './config.ts';
import { getJson } from './engines/http.ts';

/** Engines that serve an OpenAI-style `/models` list and take their model from it. */
export const OPENAI_LIKE_ENGINES = ['openai-compatible'] as const;
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
    const id = isRecord(entry) ? entry['id'] : undefined;
    return typeof id === 'string' && id.length > 0 && id.length <= 300 && /^[^-\s][^\s]*$/.test(id)
      ? [id]
      : [];
  });
  return [...new Set(ids)];
}

function endpointKey(id: string, endpoint: DiscoveryEndpoint): string {
  return JSON.stringify([id, endpoint.url, endpoint.model, endpoint.tokenEnv ?? null]);
}

interface Discovered {
  readonly key: string;
  readonly models: readonly string[];
}

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

  /** Ask the server for its models; falls back to the configured one when it cannot answer. */
  async refresh(id: OpenAILikeEngine, endpoint: DiscoveryEndpoint | undefined): Promise<void> {
    if (endpoint === undefined) {
      this.#found.delete(id);
      return;
    }
    const models = await this.#list(endpoint);
    this.#found.set(id, { key: endpointKey(id, endpoint), models });
  }

  async #list(endpoint: DiscoveryEndpoint): Promise<readonly string[]> {
    const token =
      endpoint.tokenEnv !== undefined && tokenAllowed(endpoint.url)
        ? this.#env[endpoint.tokenEnv]
        : undefined;
    try {
      const response = await getJson(`${endpoint.url.replace(/\/+$/, '')}/models`, {
        token,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        maxBytes: DISCOVERY_MAX_BYTES,
        fetch: this.#fetch,
      });
      return [endpoint.model, ...parseModelIds(response).filter((id) => id !== endpoint.model)];
    } catch {
      return [endpoint.model];
    }
  }
}
