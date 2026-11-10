/**
 * `agent.create.before` → `routing`. A waiting hook: a throw or a slow answer would fail agent
 * creation, so the whole hook has a ~2 s budget and returns `undefined` (no change) on any failure,
 * when not enforced, or when the chosen preset is not mapped.
 */
import type { AgentSessionConfig } from '@getpaseo/protocol/agent-types';

import type { DecisionModels } from '../shared/decision.ts';
import { applyPreset, presetTarget, routeTarget } from '../shared/presets.ts';
import { errorText, type HookDeps } from './deps.ts';
import { buildRoutingInput } from './history.ts';
import { pluginEnforces } from './turn.ts';
import type { UsageLinks } from './usage.ts';

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
  usage?: UsageLinks,
): (
  payload: { request: CreateRequest },
  ctx: { signal: AbortSignal },
) => Promise<CreateRequest | undefined> {
  return async ({ request }, ctx) => {
    const budget = AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]);
    try {
      return await withBudget(route(deps, request, budget, usage), budget);
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

/** What the agent runs on unchanged, and what each preset would switch it to, for savings stats. */
export function routingModels(
  config: { provider: string; model?: string | undefined },
  presets: Parameters<typeof presetTarget>[0],
): DecisionModels {
  const routes: Record<string, string> = {};
  for (const preset of Object.keys(presets)) {
    const target = presetTarget(presets, `route:${preset}`);
    if (target !== null) {
      routes[`route:${preset}`] = `${target.provider}/${target.model}`;
    }
  }
  const model = config.model?.trim() ?? '';
  return { ...(model === '' ? {} : { requested: `${config.provider}/${model}` }), routes };
}

async function route(
  deps: HookDeps,
  request: CreateRequest,
  signal: AbortSignal,
  usage: UsageLinks | undefined,
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
  const body = {
    harness: 'paseo' as const,
    input: { ...input },
    models: routingModels(request.config, settings.presets),
  };
  if (mode !== 'act') {
    // Shadow: nothing will be applied, so never make agent creation wait. The gateway logs it.
    const pending = gateway
      .decide(ROUTING_POLICY, body, { timeoutMs: SHADOW_TIMEOUT_MS })
      .catch(() => null);
    usage?.creating(
      request.config.cwd,
      request.config.title,
      pending.then((r) => r?.decisionId ?? null),
    );
    return undefined;
  }
  const pending = gateway.decide(ROUTING_POLICY, body, { timeoutMs: ROUTING_BUDGET_MS, signal });
  usage?.creating(
    request.config.cwd,
    request.config.title,
    pending.then(
      (r) => r?.decisionId ?? null,
      () => null,
    ),
  );
  const res = await pending;
  if (res === null || !pluginEnforces(res, mode)) {
    return undefined;
  }
  // The gateway resolves presets from config.yaml; settings.presets is the pre-config.yaml map.
  const target =
    res.route === undefined ? presetTarget(settings.presets, res.action) : routeTarget(res.route);
  if (target === null) {
    return undefined;
  }
  deps.log(`routing ${res.action} → ${target.provider}/${target.model} (${res.decisionId})`);
  return { ...request, config: applyPreset(request.config, target) };
}
