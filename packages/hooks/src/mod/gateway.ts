/**
 * The mod's gateway access: environment, call lookup, decision and outcome posts, and the time
 * budget. Everything fails to `null` (or a no-op) so the mod fails open to the classifier.
 */
import {
  DEFAULT_GATEWAY_URL,
  tokenAllowed,
  trimTrailingSlashes,
  type DecideRequest,
  type DecideResponse,
} from '@ziptie-soft/local-decider-core';

import type { CallInfo } from './check.ts';
import type { ModApi } from './types.ts';

const DEFAULT_BUDGET_MS = 1500;

export interface ModEnv {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly budgetMs: number;
  /** `LOCAL_DECIDER_MOD=off` */
  readonly off: boolean;
  /** A host (Paseo) runs the permission policy itself. */
  readonly hostPermission: boolean;
}

/** `$.env.get` accepts literal names only, so each variable is read by its own call. */
export async function readEnv($: ModApi): Promise<ModEnv> {
  const hostPolicies = await $.env.get('LOCAL_DECIDER_HOST_POLICIES');
  const url = await $.env.get('LOCAL_DECIDER_URL');
  const token = await $.env.get('LOCAL_DECIDER_TOKEN');
  const mod = await $.env.get('LOCAL_DECIDER_MOD');
  const timeout = Number(await $.env.get('LOCAL_DECIDER_TIMEOUT_MS'));
  const baseUrl = trimTrailingSlashes(url === undefined || url === '' ? DEFAULT_GATEWAY_URL : url);
  return {
    baseUrl,
    token: token !== undefined && token !== '' && tokenAllowed(baseUrl) ? token : undefined,
    budgetMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_BUDGET_MS,
    off: mod === 'off',
    hostPermission: (hostPolicies ?? '').split(',').some((p) => p.trim() === 'permission'),
  };
}

/** `p`, or `null` once `ms` have passed. `$.http.fetch` has no timeout of its own. */
export async function within<T>($: ModApi, ms: number, p: Promise<T>): Promise<T | null> {
  return Promise.race([p, $.clock.sleep(ms).then(() => null)]);
}

function headers(env: ModEnv, json: boolean): Record<string, string> {
  return {
    accept: 'application/json',
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(env.token === undefined ? {} : { authorization: `Bearer ${env.token}` }),
  };
}

async function request<T>(
  $: ModApi,
  env: ModEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T | null> {
  try {
    const res = await $.http.fetch(`${env.baseUrl}${path}`, {
      method,
      headers: headers(env, body !== undefined),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res.ok ? (JSON.parse(res.text) as T) : null;
  } catch {
    return null;
  }
}

/** What the gateway recorded for a tool call (permission mode, decisions, scope modes). */
export async function getCall($: ModApi, env: ModEnv, id: string): Promise<CallInfo | null> {
  return request<CallInfo>($, env, 'GET', `/v1/calls/${encodeURIComponent(id)}`);
}

/** Run a policy. Never rejects; `null` when the gateway is unreachable or errors. */
export async function decide(
  $: ModApi,
  env: ModEnv,
  policy: string,
  body: DecideRequest,
): Promise<DecideResponse | null> {
  return request<DecideResponse>($, env, 'POST', `/v1/decide/${encodeURIComponent(policy)}`, body);
}

/** Report what the classifier decided for a decision. Never rejects. */
export async function postOutcome(
  $: ModApi,
  env: ModEnv,
  decisionId: string,
  outcome: 'allow' | 'deny',
): Promise<void> {
  await request($, env, 'POST', '/v1/outcomes', { decisionId, outcome, source: 'classifier' });
}
