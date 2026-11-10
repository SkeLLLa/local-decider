import type { DecideRequest, DecideResponse, GatewayHealth, OutcomeSource } from './decision.ts';
/**
 * Fail-open client of the local-decider gateway, with the same semantics as core's
 * `GatewayClient`: every call has a hard timeout and resolves to `null` on any failure (gateway
 * down, slow, non-2xx, bad JSON, aborted), so hooks fall back to Paseo's default behaviour.
 * Uses only the global `fetch` and `AbortSignal`, so it has no runtime dependencies.
 */
import { normaliseBaseUrl, tokenAllowed } from './url.ts';

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
  /** `GET /v1/engines`: engines, their models, downloads and the active selection. */
  engines(options?: CallOptions): Promise<unknown>;
  stats(options?: CallOptions): Promise<unknown>;
  /**
   * `POST /v1/engine`: switch the served engine and model (the gateway persists it). Device
   * `auto` or absent keeps the gateway's device. Unlike the read calls, reports why it failed.
   */
  selectEngine(selection: EngineSelection, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/models/download`: start downloading a model; 202 with `{download}`. */
  downloadModel(
    target: { engine: string; model: string },
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/engines/validate`: re-run an engine's self check (FastFlowLM's `flm validate`). */
  validateEngine(engine: string, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/paths`: set a tool path or directory; null returns to automatic discovery. */
  setPath(key: string, value: string | null, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/load` (202) or `/v1/engine/unload`: load the model now, or free it. */
  engineLoad(action: 'load' | 'unload', options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/lifecycle`: lazy (load on demand, unload when idle) or eager; persisted. */
  setLifecycle(lifecycle: Lifecycle, options?: CallOptions): Promise<PostResult>;
}

export interface Lifecycle {
  readonly lifecycle: 'lazy' | 'eager';
  readonly idleUnloadMinutes?: number;
}

export interface EngineSelection {
  readonly engine?: string;
  readonly model: string;
  readonly device?: string;
}

/** A mutating call's outcome: the response body, or the gateway's error message. */
export type PostResult = { ok: true; body: unknown } | { ok: false; error: string };

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unreachable';
}

async function failure(res: Response): Promise<PostResult> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const reason = typeof body?.error === 'string' ? body.error.slice(0, 300) : '';
  return { ok: false, error: reason === '' ? `HTTP ${String(res.status)}` : reason };
}

/** Device `auto` (or none) is left out so the gateway keeps its own. */
function selectionBody(selection: EngineSelection): Record<string, string> {
  const body: Record<string, string> = { model: selection.model };
  if (selection.engine !== undefined && selection.engine !== '') {
    body['engine'] = selection.engine;
  }
  if (selection.device !== undefined && selection.device !== 'auto') {
    body['device'] = selection.device;
  }
  return body;
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
  // Never send the token in clear text to another machine.
  const token = tokenAllowed(baseUrl) ? options.token : undefined;

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

  async function post(
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<PostResult> {
    try {
      const res = await send('POST', path, body, call);
      if (!res.ok) {
        return await failure(res);
      }
      return { ok: true, body: await res.json().catch(() => null) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
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
    engines: async (call) => request('GET', '/v1/engines', undefined, call),
    stats: async (call) => request('GET', '/v1/stats', undefined, call),
    selectEngine: async (selection, call) => post('/v1/engine', selectionBody(selection), call),
    downloadModel: async (target, call) => post('/v1/models/download', { ...target }, call),
    validateEngine: async (engine, call) => post('/v1/engines/validate', { engine }, call),
    setPath: async (key, value, call) => post('/v1/paths', { key, value }, call),
    engineLoad: async (action, call) => post(`/v1/engine/${action}`, {}, call),
    setLifecycle: async (lifecycle, call) => post('/v1/engine/lifecycle', { ...lifecycle }, call),
  };
}
