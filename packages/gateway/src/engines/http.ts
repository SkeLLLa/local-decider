import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';

import { EngineError } from './types.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HttpEngineOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch;
}

function headers(token: string | undefined, hasBody: boolean): Record<string, string> {
  const out: Record<string, string> = hasBody
    ? { 'content-type': 'application/json', 'accept': 'application/json' }
    : { accept: 'application/json' };
  if (token !== undefined && token !== '') {
    out['authorization'] = `Bearer ${token}`;
  }
  return out;
}

function isResponse(value: unknown): value is SystemOneResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { answers?: unknown }).answers === 'object' &&
    (value as { answers?: unknown }).answers !== null
  );
}

/** The body as text; stops reading (leaving the loop cancels the stream) once past `max` bytes. */
async function readLimited(res: Response, max: number): Promise<string> {
  if (res.body === null) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > max) {
      throw new EngineError('engine response too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface JsonRequestOptions {
  readonly token?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly maxBytes?: number | undefined;
  /** Injected in tests. */
  readonly fetch?: typeof fetch | undefined;
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: JsonRequestOptions,
): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      ...init,
      redirect: 'error',
      headers: headers(options.token, init.body !== undefined),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new EngineError(`engine unreachable: ${(error as Error).message}`);
  }
  const text = await readLimited(res, options.maxBytes ?? MAX_RESPONSE_BYTES);
  if (!res.ok) {
    throw new EngineError(`engine HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EngineError('engine returned invalid JSON');
  }
}

/** POST JSON and parse a size-limited JSON response. */
export function postJson(
  url: string,
  body: unknown,
  options: JsonRequestOptions = {},
): Promise<unknown> {
  const serialized = JSON.stringify(body);
  return requestJson(
    url,
    { method: 'POST', ...(serialized === undefined ? {} : { body: serialized }) },
    options,
  );
}

/** GET and parse a size-limited JSON response. */
export function getJson(url: string, options: JsonRequestOptions = {}): Promise<unknown> {
  return requestJson(url, { method: 'GET' }, options);
}

/** POST a request to `<baseUrl>/v1/systemone`. Throws {@link EngineError} on any failure. */
export async function postSystemOne(
  options: HttpEngineOptions,
  request: SystemOneRequest,
  signal: AbortSignal,
): Promise<SystemOneResponse> {
  const body = await postJson(`${options.baseUrl.replace(/\/+$/, '')}/v1/systemone`, request, {
    token: options.token,
    signal,
    maxBytes: MAX_RESPONSE_BYTES,
    fetch: options.fetch,
  });
  if (!isResponse(body)) {
    throw new EngineError('engine response has no answers');
  }
  return body;
}

/** GET `<baseUrl><path>` (default `/health`); resolves to the parsed body or null. */
export async function getHealth(
  baseUrl: string,
  timeoutMs: number,
  path = '/health',
  doFetch: typeof fetch = globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    const body: unknown = await res.json().catch(() => ({}));
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}
