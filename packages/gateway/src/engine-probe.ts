/**
 * `POST /v1/engines/discover`: find OpenAI-compatible servers and list their models before an
 * engine is configured. Probes are bounded and read-only: GET `/models`-style lists, a shared 1 s
 * deadline, a 256 KiB cap, no redirects, no credentials, no inference. Server replies are
 * untrusted data; results hold only filtered model ids and a short, value-free reason.
 */
import { z } from 'zod';

import { normalizeUrl } from './engine-connection.ts';
import { nativeModelsUrl, OPENAI_LIKE_ENGINES, type OpenAILikeEngine } from './engine-discovery.ts';
import { getJson } from './engines/http.ts';

const PROBE_DEADLINE_MS = 1000;
const PROBE_MAX_BYTES = 256 * 1024;
const MAX_CONCURRENT = 3;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;
const MAX_SCANNED_ENTRIES = 1000;
const MAX_MODELS = 200;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** Fixed local suggestions: LM Studio, Ollama and llama.cpp default ports. */
const SUGGESTION_URLS: readonly string[] = [
  'http://127.0.0.1:1234/v1',
  'http://127.0.0.1:11434/v1',
  'http://127.0.0.1:8080/v1',
];

export type ServerKind = OpenAILikeEngine;

interface ProbeResult {
  readonly url: string;
  readonly kind: ServerKind;
  readonly state: 'reachable' | 'error';
  readonly models: readonly string[];
  /** Why the probe failed; fixed wording, never server text or request values. */
  readonly reason?: string;
}

/** `auto` tries LM Studio's native API first; `openai` only reads `/models`. */
type Mode = 'auto' | 'openai';

export type DiscoverRequest =
  | { readonly kind: 'suggestions' }
  | { readonly kind: 'url'; readonly engine: ServerKind; readonly url: string };

const bodySchema = z.strictObject({ engine: z.enum(OPENAI_LIKE_ENGINES), url: z.string() });

/** Empty body: suggestions. `{engine, url}`: models of that URL. Messages carry no values. */
export function parseDiscoverRequest(body: unknown): DiscoverRequest {
  const empty =
    body === undefined ||
    body === null ||
    (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0);
  if (empty) {
    return { kind: 'suggestions' };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('invalid body; expected {} or {engine, url}');
  }
  const url = normalizeUrl(parsed.data.url);
  if (url === undefined) {
    throw new Error('invalid url; expected an http(s) base URL without credentials or query');
  }
  return { kind: 'url', engine: parsed.data.engine, url };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ids from `{data: [{id}]}`: bounded scan, strict charset and length, unique, capped count. */
export function safeModelIds(entries: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries.slice(0, MAX_SCANNED_ENTRIES)) {
    const id = isRecord(entry) ? entry['id'] : undefined;
    if (typeof id === 'string' && MODEL_ID.test(id)) {
      ids.add(id);
      if (ids.size >= MAX_MODELS) {
        break;
      }
    }
  }
  return [...ids];
}

function dataArray(value: unknown): readonly unknown[] | undefined {
  const data = isRecord(value) ? value['data'] : undefined;
  return Array.isArray(data) ? (data as unknown[]) : undefined;
}

/** Maps a failure to fixed wording; the error text is server- or network-supplied. */
function reasonFor(error: unknown, timedOut: boolean): string {
  if (timedOut) {
    return 'timed out';
  }
  const message = error instanceof Error ? error.message : '';
  const status = /^engine HTTP (\d{3})/.exec(message)?.[1];
  if (status !== undefined) {
    return `HTTP ${status}`;
  }
  if (message.includes('too large')) {
    return 'response too large';
  }
  if (message.includes('invalid JSON')) {
    return 'not a JSON response';
  }
  return 'unreachable';
}

class Limiter {
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}

interface CacheEntry {
  readonly at: number;
  readonly result: ProbeResult;
}

export interface ServerProbeOptions {
  /** Injected in tests. */
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
}

export class ServerProbe {
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<ProbeResult>>();
  readonly #limiter = new Limiter();

  constructor(options: ServerProbeOptions = {}) {
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
  }

  async discover(request: DiscoverRequest): Promise<Record<string, unknown>> {
    if (request.kind === 'suggestions') {
      const suggestions = await Promise.all(
        SUGGESTION_URLS.map((url) => this.#cached(url, 'auto')),
      );
      return { suggestions };
    }
    const mode: Mode = request.engine === 'lmstudio' ? 'auto' : 'openai';
    return { server: await this.#cached(request.url, mode) };
  }

  /** Cached hit or miss for 30 s, keyed by mode and normalized URL; concurrent calls share one probe. */
  #cached(url: string, mode: Mode): Promise<ProbeResult> {
    const key = `${mode} ${url}`;
    const hit = this.#cache.get(key);
    if (hit !== undefined && this.#now() - hit.at < CACHE_TTL_MS) {
      return Promise.resolve(hit.result);
    }
    const pending = this.#inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const started = this.#limiter
      .run(() => this.#probe(url, mode))
      .then((result) => {
        this.#remember(key, result);
        return result;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, started);
    return started;
  }

  #remember(key: string, result: ProbeResult): void {
    const now = this.#now();
    this.#cache.delete(key);
    for (const [old, entry] of this.#cache) {
      if (now - entry.at >= CACHE_TTL_MS || this.#cache.size >= MAX_CACHE_ENTRIES) {
        this.#cache.delete(old);
      }
    }
    this.#cache.set(key, { at: now, result });
  }

  async #probe(url: string, mode: Mode): Promise<ProbeResult> {
    const signal = AbortSignal.timeout(PROBE_DEADLINE_MS);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('deadline')), PROBE_DEADLINE_MS);
    });
    try {
      return await Promise.race([this.#read(url, mode, signal), deadline]);
    } catch (error) {
      const timedOut = signal.aborted || (error instanceof Error && error.message === 'deadline');
      return {
        url,
        kind: 'openai-compatible',
        state: 'error',
        models: [],
        reason: reasonFor(error, timedOut),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async #read(url: string, mode: Mode, signal: AbortSignal): Promise<ProbeResult> {
    if (mode === 'auto') {
      const native = await this.#get(nativeModelsUrl(url), signal).then(dataArray, () => undefined);
      if (native !== undefined) {
        const usable = native.filter(
          (e) => isRecord(e) && (e['type'] === 'llm' || e['type'] === 'vlm'),
        );
        return { url, kind: 'lmstudio', state: 'reachable', models: safeModelIds(usable) };
      }
    }
    const list = dataArray(await this.#get(`${url}/models`, signal));
    if (list === undefined) {
      throw new Error('invalid JSON');
    }
    return { url, kind: 'openai-compatible', state: 'reachable', models: safeModelIds(list) };
  }

  #get(url: string, signal: AbortSignal): Promise<unknown> {
    return getJson(url, { signal, maxBytes: PROBE_MAX_BYTES, fetch: this.#fetch });
  }
}
