/**
 * `agent.create.before` → `routing`. A waiting hook: a throw or a slow answer would fail agent
 * creation, so the whole hook has a ~2 s budget and returns `undefined` (no change) on any failure,
 * when not enforced, or when the chosen preset is not mapped.
 */
import type { AgentSessionConfig } from '@getpaseo/protocol/agent-types';

import { presetTarget, applyPreset } from '../shared/presets.ts';
import { errorText, type HookDeps } from './deps.ts';
import { buildRoutingInput } from './history.ts';
import { pluginEnforces } from './turn.ts';

const ROUTING_POLICY = 'routing';
const ROUTING_BUDGET_MS = 2000;
const SHADOW_TIMEOUT_MS = 30_000;

export interface CreateRequest {
  config: AgentSessionConfig;
  env?: Record<string, string>;
}

export function createRoutingHandler(
  deps: HookDeps,
  budgetMs = ROUTING_BUDGET_MS,
): (
  payload: { request: CreateRequest },
  ctx: { signal: AbortSignal },
) => Promise<CreateRequest | undefined> {
  return async ({ request }, ctx) => {
    const budget = AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]);
    try {
      return await withBudget(route(deps, request, budget), budget);
    } catch (error) {
      deps.log(`routing skipped: ${errorText(error)}`);
      return undefined;
    }
  };
}

/** Settle like `work`, or with `undefined` as soon as `signal` aborts, whatever `work` is still doing. */
function withBudget<T>(work: Promise<T | undefined>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function route(
  deps: HookDeps,
  request: CreateRequest,
  signal: AbortSignal,
): Promise<CreateRequest | undefined> {
  // Internal helper agents (commit messages, titles) are not user tasks.
  if (request.config.internal === true || deps.gatewayKnownDown?.() === true) {
    return undefined;
  }
  const settings = await deps.settings();
  const mode = settings.modes[ROUTING_POLICY];
  const input = buildRoutingInput(request.config.cwd, request.config.title);
  const gateway = mode === 'off' || input === null ? null : await deps.gateway();
  if (gateway === null || input === null) {
    return undefined;
  }
  const body = { harness: 'paseo' as const, input: { ...input } };
  if (mode !== 'act') {
    // Shadow: nothing will be applied, so never make agent creation wait. The gateway logs it.
    void gateway
      .decide(ROUTING_POLICY, body, { timeoutMs: SHADOW_TIMEOUT_MS })
      .catch(() => undefined);
    return undefined;
  }
  const res = await gateway.decide(ROUTING_POLICY, body, { timeoutMs: ROUTING_BUDGET_MS, signal });
  if (res === null || !pluginEnforces(res, mode)) {
    return undefined;
  }
  const target = presetTarget(settings.presets, res.action);
  if (target === null) {
    return undefined;
  }
  deps.log(`routing ${res.action} → ${target.provider}/${target.model} (${res.decisionId})`);
  return { ...request, config: applyPreset(request.config, target) };
}
