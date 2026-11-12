/**
 * Minimal gateway client for harness adapters. Every call has a hard timeout and returns `null`
 * instead of throwing, so callers fail open to the harness's default behaviour.
 */
import type { DecideRequest, DecideResponse } from './decision.ts';

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8765';
export const CONTROL_HEADER = 'x-local-decider-control';

/** `value` without trailing `/`. A loop, not `/\/+$/`, which backtracks quadratically on long runs. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return value.slice(0, end);
}

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Bearer token for a remote gateway. Read from the environment by the caller; never logged. */
  readonly token?: string;
  /** Local control token. Sent only when `baseUrl` points to loopback. */
  readonly controlToken?: string | undefined;
  readonly fetch?: typeof fetch;
}

export interface GatewayHealth {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly engine?: string;
  readonly model?: string;
  /** `stopped|starting|ready|failed`; `detail` says why it is not ready. */
  readonly engineState?: string;
  readonly detail?: string;
  readonly p50Ms?: number;
}

export interface EngineSelectionRequest {
  readonly engine: string;
  readonly model: string;
  readonly device?: string;
}

export interface GatewayRequestResult {
  readonly status: number;
  readonly body: unknown;
}

const LOOPBACK = new Set(['localhost', '[::1]', '::1']);
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True when a URL's host is this machine. */
export function loopbackUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return LOOPBACK.has(hostname) || LOOPBACK_V4.test(hostname);
  } catch {
    return false;
  }
}

/** True for https URLs and loopback hosts; a bearer token is only sent to those. */
export function tokenAllowed(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:' || loopbackUrl(baseUrl);
  } catch {
    return false;
  }
}

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #token: string | undefined;
  readonly #controlToken: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = trimTrailingSlashes(options.baseUrl ?? DEFAULT_GATEWAY_URL);
    this.#timeoutMs = options.timeoutMs ?? 2000;
    // Never send the token in clear text to another machine: https, or loopback only.
    this.#token = tokenAllowed(this.#baseUrl) ? options.token : undefined;
    this.#controlToken =
      loopbackUrl(this.#baseUrl) && options.controlToken !== '' ? options.controlToken : undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Run a policy. `null` when the gateway is unreachable, slow, or answers with an error. */
  async decide(policy: string, request: DecideRequest): Promise<DecideResponse | null> {
    return this.#request<DecideResponse>(
      'POST',
      `/v1/decide/${encodeURIComponent(policy)}`,
      request,
    );
  }

  async reportOutcome(decisionId: string, outcome: string, source = 'user'): Promise<boolean> {
    const res = await this.#request('POST', '/v1/outcomes', { decisionId, outcome, source });
    return res !== null;
  }

  async health(): Promise<GatewayHealth | null> {
    return this.#request<GatewayHealth>('GET', '/health');
  }

  /** List engines and models; null when the gateway is unreachable or returns an error. */
  async engines(): Promise<unknown> {
    return this.#request<unknown>('GET', '/v1/engines');
  }

  /** Select a model and retain its HTTP status and body for CLI error reporting. */
  async selectEngine(selection: EngineSelectionRequest): Promise<GatewayRequestResult | null> {
    return this.#requestWithStatus('POST', '/v1/engine', selection);
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const result = await this.#requestWithStatus(method, path, body);
    return result !== null && result.status >= 200 && result.status < 300
      ? (result.body as T)
      : null;
  }

  async #requestWithStatus(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<GatewayRequestResult | null> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.#token !== undefined && this.#token !== '') {
      headers['authorization'] = `Bearer ${this.#token}`;
    }
    if (this.#controlToken !== undefined) {
      headers[CONTROL_HEADER] = this.#controlToken;
    }
    try {
      const res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return null;
    }
  }
}
