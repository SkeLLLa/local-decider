/**
 * Minimal gateway client for harness adapters. Every call has a hard timeout and returns `null`
 * instead of throwing, so callers fail open to the harness's default behaviour.
 */
import type { DecideRequest, DecideResponse } from './decision.ts';

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8765';

export interface ClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Bearer token for a remote gateway. Read from the environment by the caller; never logged. */
  readonly token?: string;
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

export class GatewayClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 2000;
    this.#token = options.token;
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

  async #request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (this.#token !== undefined && this.#token !== '') {
      headers['authorization'] = `Bearer ${this.#token}`;
    }
    try {
      const res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        return null;
      }
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
}
