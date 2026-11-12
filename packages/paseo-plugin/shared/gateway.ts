/**
 * Fail-open client of the local-decider gateway, with the same semantics as core's
 * `GatewayClient`: every call has a hard timeout and resolves to `null` on any failure (gateway
 * down, slow, non-2xx, bad JSON, aborted), so hooks fall back to Paseo's default behaviour.
 * Uses only the global `fetch` and `AbortSignal`, so it has no runtime dependencies.
 */
import { CONTROL_HEADER, REPORT_HEADER } from './constants.ts';
import type {
  DecideRequest,
  DecideResponse,
  GatewayHealth,
  OutcomeSource,
  UsageReport,
} from './decision.ts';
import { bearerAllowed, loopbackUrl, normaliseBaseUrl } from './url.ts';

export interface GatewayOptions {
  readonly baseUrl?: string;
  /** Default per-call budget. */
  readonly timeoutMs?: number;
  /** Bearer token for a remote gateway; read from the daemon environment, never logged. */
  readonly token?: string | undefined;
  readonly tokenOrigin?: string | undefined;
  /** Server-only token for authenticating outcome reports to a local gateway. */
  readonly reportToken?: string | undefined;
  readonly controlToken?: string | undefined;
  /** Called after any 401; never receives a token. */
  readonly onUnauthorised?: (() => void) | undefined;
  readonly fetch?: typeof fetch;
}

export interface CallOptions {
  readonly timeoutMs?: number;
  /** Caller's abort signal, e.g. a hook's `ctx.signal`. */
  readonly signal?: AbortSignal;
}

export interface Gateway {
  readonly baseUrl: string;
  readonly bearer: boolean;
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
  /** `POST /v1/usage`: token counts of one agent turn; false when not recorded. */
  reportUsage(usage: UsageReport, options?: CallOptions): Promise<boolean>;
  health(options?: CallOptions): Promise<GatewayHealth | null>;
  /** `GET /v1/engines`: engines, their models, downloads and the active selection. */
  engines(options?: CallOptions): Promise<unknown>;
  stats(options?: CallOptions): Promise<unknown>;
  /**
   * `POST /v1/engine`: switch the served engine and model (the gateway persists it). Device
   * `auto` or absent keeps the gateway's device. Unlike the read calls, reports why it failed.
   */
  selectEngine(selection: EngineSelection, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/mode`: automatic selection on, or manual keeping the running engine. */
  setSelectionMode(
    mode: 'auto' | 'manual',
    family?: string,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `GET /v1/benchmark`: the benchmark job's view; null when the gateway does not answer. */
  benchmark(options?: CallOptions): Promise<unknown>;
  /** `POST /v1/benchmark`: start a job (202 with its view); `client: 'paseo'` is added. */
  benchmarkStart(
    body: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/benchmark/cancel`: stop the running job; 409 when none runs. */
  benchmarkCancel(options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/models/download`: start downloading a model; 202 with `{download}`. */
  downloadModel(
    target: { engine: string; model: string },
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/engines/validate`: re-run an engine's self check (FastFlowLM's `flm validate`). */
  validateEngine(engine: string, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/config/engine`: save an OpenAI-like engine's URL, model and token variable name. */
  saveEngineConnection(
    body: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/engines/discover`: `{}` lists local servers, `{engine, url}` probes one URL. */
  discoverServers(
    body: Readonly<Record<string, unknown>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/paths`: set a tool path or directory; null returns to automatic discovery. */
  setPath(key: string, value: string | null, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/load` (202) or `/v1/engine/unload`: load the model now, or free it. */
  engineLoad(action: 'load' | 'unload', options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/engine/lifecycle`: lazy (load on demand, unload when idle) or eager; persisted. */
  setLifecycle(lifecycle: Lifecycle, options?: CallOptions): Promise<PostResult>;
  /** `POST /v1/policies/:id/mode`: the gateway's run mode for a policy; persisted. */
  setPolicyMode(policy: string, mode: string, options?: CallOptions): Promise<PostResult>;
  /** `GET /v1/policies`: every policy with its routes, and for each base policy its variants. */
  policies(options?: CallOptions): Promise<unknown>;
  /** `POST /v1/policies/:id/variant`: which variant answers for a policy; persisted. */
  setPolicyVariant(policy: string, variant: string, options?: CallOptions): Promise<PostResult>;
  /**
   * `POST /v1/policies/:id/thresholds`: override rule thresholds by `<question>.<answer>`, null
   * restores the policy file's value; persisted in config.yaml.
   */
  setPolicyThresholds(
    policy: string,
    thresholds: Readonly<Record<string, number | null>>,
    options?: CallOptions,
  ): Promise<PostResult>;
  /** `POST /v1/policies/reload`: re-read the policy files, e.g. after adding one. */
  reloadPolicies(options?: CallOptions): Promise<PostResult>;
  /** `GET /v1/config`: config.yaml's path, schemas and content as the gateway applies it. */
  config(options?: CallOptions): Promise<unknown>;
  /** `POST /v1/routing/presets`: map a preset for a harness in config.yaml; null model removes. */
  setRoutingPreset(update: PresetUpdate, options?: CallOptions): Promise<PostResult>;
  /** `GET /v1/policies/:id/prompt`: the prompt that has an agent write a variant of `id`. */
  policyPrompt(policy: string, options?: CallOptions): Promise<unknown>;
}

/** Without a model and a profile, the mapping is removed. */
export interface PresetUpdate {
  readonly harness: 'paseo';
  readonly preset: string;
  readonly model?: string;
  readonly profile?: string;
  readonly mode?: string;
  readonly thinking?: string;
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
const BENCHMARK_READ_MS = 3000;
const BENCHMARK_POST_MS = 10_000;

function credentials(
  baseUrl: string,
  options: GatewayOptions,
): { token?: string; reportToken?: string; controlToken?: string } {
  const local = loopbackUrl(baseUrl);
  return {
    ...(options.token && bearerAllowed(baseUrl, options.tokenOrigin)
      ? { token: options.token }
      : {}),
    ...(local && options.reportToken ? { reportToken: options.reportToken } : {}),
    ...(local && options.controlToken ? { controlToken: options.controlToken } : {}),
  };
}

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

function notifyUnauthorised(res: Response, callback: (() => void) | undefined): void {
  if (res.status === 401) callback?.();
}

export function createGateway(options: GatewayOptions = {}): Gateway | null {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  if (baseUrl === null) {
    return null;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const { token, reportToken, controlToken } = credentials(baseUrl, options);

  function headersFor(body: unknown, path: string): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (token !== undefined && token !== '') {
      headers['authorization'] = `Bearer ${token}`;
    }
    if (path === '/v1/outcomes' && reportToken !== undefined && reportToken !== '') {
      headers[REPORT_HEADER] = reportToken;
    }
    if (controlToken !== undefined && controlToken !== '') {
      headers[CONTROL_HEADER] = controlToken;
    }
    return headers;
  }

  async function send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: CallOptions | undefined,
  ): Promise<Response> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: headersFor(body, path),
      redirect: 'error',
      signal: signalFor(timeoutMs, call),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    notifyUnauthorised(res, options.onUnauthorised);
    return res;
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
    bearer: token !== undefined,
    async decide(policy, req, call) {
      const res = await request('POST', `/v1/decide/${encodeURIComponent(policy)}`, req, call);
      return isDecideResponse(res) ? res : null;
    },
    async reportOutcome(decisionId, outcome, source, call) {
      const res = await request('POST', '/v1/outcomes', { decisionId, outcome, source }, call);
      return res !== null;
    },
    async reportUsage(usage, call) {
      return (await request('POST', '/v1/usage', usage, call)) !== null;
    },
    async health(call) {
      const res = await request('GET', '/health', undefined, call);
      return isHealth(res) ? res : null;
    },
    engines: async (call) => request('GET', '/v1/engines', undefined, call),
    stats: async (call) => request('GET', '/v1/stats', undefined, call),
    selectEngine: async (selection, call) => post('/v1/engine', selectionBody(selection), call),
    setSelectionMode: async (mode, family, call) =>
      post('/v1/engine/mode', family === undefined ? { mode } : { mode, family }, call),
    benchmark: async (call) =>
      request('GET', '/v1/benchmark', undefined, { timeoutMs: BENCHMARK_READ_MS, ...call }),
    benchmarkStart: async (body, call) =>
      post(
        '/v1/benchmark',
        { ...body, client: 'paseo' },
        { timeoutMs: BENCHMARK_POST_MS, ...call },
      ),
    benchmarkCancel: async (call) =>
      post('/v1/benchmark/cancel', {}, { timeoutMs: BENCHMARK_POST_MS, ...call }),
    downloadModel: async (target, call) => post('/v1/models/download', { ...target }, call),
    validateEngine: async (engine, call) => post('/v1/engines/validate', { engine }, call),
    saveEngineConnection: async (body, call) => post('/v1/config/engine', { ...body }, call),
    discoverServers: async (body, call) => post('/v1/engines/discover', { ...body }, call),
    setPath: async (key, value, call) => post('/v1/paths', { key, value }, call),
    engineLoad: async (action, call) => post(`/v1/engine/${action}`, {}, call),
    setLifecycle: async (lifecycle, call) => post('/v1/engine/lifecycle', { ...lifecycle }, call),
    setPolicyMode: async (policy, mode, call) =>
      post(`/v1/policies/${encodeURIComponent(policy)}/mode`, { mode }, call),
    policies: async (call) => request('GET', '/v1/policies', undefined, call),
    setPolicyVariant: async (policy, variant, call) =>
      post(`/v1/policies/${encodeURIComponent(policy)}/variant`, { variant }, call),
    setPolicyThresholds: async (policy, thresholds, call) =>
      post(
        `/v1/policies/${encodeURIComponent(policy)}/thresholds`,
        { thresholds: { ...thresholds } },
        call,
      ),
    reloadPolicies: async (call) => post('/v1/policies/reload', {}, call),
    config: async (call) => request('GET', '/v1/config', undefined, call),
    setRoutingPreset: async (update, call) => post('/v1/routing/presets', { ...update }, call),
    policyPrompt: async (policy, call) =>
      request('GET', `/v1/policies/${encodeURIComponent(policy)}/prompt`, undefined, call),
  };
}
