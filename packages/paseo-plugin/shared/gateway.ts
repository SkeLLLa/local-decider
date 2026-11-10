import type { DecideRequest, DecideResponse, GatewayHealth, OutcomeSource } from './decision.ts';
/**
 * Fail-open client of the local-decider gateway, with the same semantics as core's
 * `GatewayClient`: every call has a hard timeout and resolves to `null` on any failure (gateway
 * down, slow, non-2xx, bad JSON, aborted), so hooks fall back to Paseo's default behaviour.
 * Uses only the global `fetch` and `AbortSignal`, so it has no runtime dependencies.
 */
import { normaliseBaseUrl } from './url.ts';

export interface GatewayOptions {
  readonly baseUrl?: string;
  /** Default per-call budget. */
  readonly timeoutMs?: number;
  /** Bearer token for a remote gateway; read from the daemon environment, never logged. */
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch;
}

export interface CallOptions {
  readonly timeoutMs?: number;
  /** Caller's abort signal, e.g. a hook's `ctx.signal`. */
  readonly signal?: AbortSignal;
}

export interface Gateway {
  readonly baseUrl: string;
  decide(
    policy: string,
    request: DecideRequest,
    options?: CallOptions,
  ): Promise<DecideResponse | null>;
  reportOutcome(
    decisionId: string,
    outcome: string,
    source: OutcomeSource,
    options?: CallOptions,
  ): Promise<boolean>;
  health(options?: CallOptions): Promise<GatewayHealth | null>;
  models(options?: CallOptions): Promise<unknown>;
  stats(options?: CallOptions): Promise<unknown>;
  /**
   * `POST /v1/engine`: switch the served model; device `auto` keeps the gateway's device. Unlike
   * the rest, reports why it failed.
   */
  selectEngine(
    selection: { model: string; device: string },
    options?: CallOptions,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

const DEFAULT_TIMEOUT_MS = 2000;

function isDecideResponse(value: unknown): value is DecideResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['decisionId'] === 'string' &&
    typeof v['action'] === 'string' &&
    typeof v['enforced'] === 'boolean' &&
    typeof v['answers'] === 'object' &&
    v['answers'] !== null
  );
}

function isHealth(value: unknown): value is GatewayHealth {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { status?: unknown }).status === 'string'
  );
}

function signalFor(defaultMs: number, options: CallOptions | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? defaultMs);
  return options?.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
}

export function createGateway(options: GatewayOptions = {}): Gateway | null {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  if (baseUrl === null) {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const token = options.token;

  function headersFor(body: unknown): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token !== undefined && token !== '') {
      headers['authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async function send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<Response> {
    return doFetch(`${baseUrl}${path}`, {
      method,
      headers: headersFor(body),
      signal: signalFor(timeoutMs, call),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<unknown> {
    try {
      const res = await send(method, path, body, call);
      if (!res.ok) {
        return null;
      }
      return await res.json();
    } catch {
      return null;
    }
  }

  return {
    baseUrl,
    async decide(policy, req, call) {
      const res = await request('POST', `/v1/decide/${encodeURIComponent(policy)}`, req, call);
      return isDecideResponse(res) ? res : null;
    },
    async reportOutcome(decisionId, outcome, source, call) {
      const res = await request('POST', '/v1/outcomes', { decisionId, outcome, source }, call);
      return res !== null;
    },
    async health(call) {
      const res = await request('GET', '/health', undefined, call);
      return isHealth(res) ? res : null;
    },
    models: async (call) => request('GET', '/models', undefined, call),
    stats: async (call) => request('GET', '/v1/stats', undefined, call),
    async selectEngine(selection, call) {
      try {
        const payload = selection.device === 'auto' ? { model: selection.model } : { ...selection };
        const res = await send('POST', '/v1/engine', payload, call);
        if (res.ok) {
          return { ok: true };
        }
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        const reason = typeof body?.error === 'string' ? body.error.slice(0, 200) : '';
        return {
          ok: false,
          error: `HTTP ${String(res.status)}${reason === '' ? '' : `: ${reason}`}`,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'unreachable' };
      }
    },
  };
}
