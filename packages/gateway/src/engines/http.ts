import type { SystemOneRequest, SystemOneResponse } from '@local-decider/core';

import { EngineError } from './types.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HttpEngineOptions {
  readonly baseUrl: string;
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch;
}

function headers(token: string | undefined): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    'accept': 'application/json',
  };
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

/** POST a request to `<baseUrl>/v1/systemone`. Throws {@link EngineError} on any failure. */
export async function postSystemOne(
  options: HttpEngineOptions,
  request: SystemOneRequest,
  signal: AbortSignal,
): Promise<SystemOneResponse> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(`${options.baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: headers(options.token),
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    throw new EngineError(`engine unreachable: ${(error as Error).message}`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new EngineError('engine response too large');
  }
  if (!res.ok) {
    throw new EngineError(`engine HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new EngineError('engine returned invalid JSON');
  }
  if (!isResponse(body)) {
    throw new EngineError('engine response has no answers');
  }
  return body;
}

/** GET `<baseUrl>/health`; resolves to the parsed body or null. */
export async function getHealth(
  baseUrl: string,
  timeoutMs: number,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/health`, {
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
