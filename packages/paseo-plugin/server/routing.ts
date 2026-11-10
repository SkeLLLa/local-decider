/**
 * `agent.create.before` → `routing`. A waiting hook: a throw or a slow answer would fail agent
 * creation, so the whole hook has a ~2 s budget and returns `undefined` (no change) on any failure,
 * when not enforced, or when the chosen preset is not mapped.
 */
import type { AgentSessionConfig } from '@getpaseo/protocol/agent-types';

import type { DecideRequest, DecideResponse, DecisionModels } from '../shared/decision.ts';
import type { Gateway } from '../shared/gateway.ts';
import {
  applyPreset,
  presetTarget,
  routeTarget,
  type PresetTarget,
  type ProfileLike,
} from '../shared/presets.ts';
import type { DeciderSettings } from '../shared/settings.ts';
import { errorText, type HookDeps } from './deps.ts';
import { buildRoutingInput } from './history.ts';
import { pluginEnforces } from './turn.ts';
import type { UsageLinks } from './usage.ts';

const ROUTING_POLICY = 'routing';
const ROUTING_BUDGET_MS = 2000;
const SHADOW_TIMEOUT_MS = 30_000;

/** Where Paseo agent profiles come from: the hook context's `paseo.config`. */
export interface ProfileSource {
  readonly config: {
    get(): Promise<{ config: { agentProfiles?: readonly ProfileLike[] | undefined } }>;
  };
}

/** Paseo's agent profiles; none when unavailable (an older Paseo, or the call failed). */
async function loadProfiles(paseo: ProfileSource | undefined): Promise<readonly ProfileLike[]> {
  try {
    return (await paseo?.config.get())?.config.agentProfiles ?? [];
  } catch {
    return [];
  }
}

export interface CreateRequest {
  config: AgentSessionConfig;
  env?: Record<string, string>;
}

interface RoutePlan {
  readonly mode: DeciderSettings['modes'][typeof ROUTING_POLICY];
  readonly settings: DeciderSettings;
  readonly gateway: Gateway;
  readonly body: DecideRequest;
  readonly profiles: readonly ProfileLike[];
}

export function createRoutingHandler(
  deps: HookDeps,
  budgetMs = ROUTING_BUDGET_MS,
  usage?: UsageLinks,
): (
  payload: { request: CreateRequest },
  ctx: { signal: AbortSignal; paseo?: ProfileSource },
) => Promise<CreateRequest | undefined> {
  return async ({ request }, ctx) => {
    const budget = AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]);
    try {
      return await withBudget(route(deps, request, budget, usage, ctx.paseo), budget);
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
  profiles: readonly ProfileLike[] = [],
): DecisionModels {
  const routes: Record<string, string> = {};
  for (const preset of Object.keys(presets)) {
    const target = presetTarget(presets, `route:${preset}`);
    if (target !== null) {
      routes[`route:${preset}`] = `${target.provider}/${target.model}`;
    }
  }
  const model = config.model?.trim() ?? '';
  return {
    ...(model === '' ? {} : { requested: `${config.provider}/${model}` }),
    routes,
    ...profileModels(profiles),
  };
}

/** Profile id → `provider/model`, so the gateway can resolve config.yaml profile presets. */
function profileModels(profiles: readonly ProfileLike[]): { profiles?: Record<string, string> } {
  const out: Record<string, string> = {};
  for (const p of profiles) {
    const model = p.model?.trim() ?? '';
    if (model !== '') {
      out[p.id] = `${p.provider}/${model}`;
    }
  }
  return Object.keys(out).length > 0 ? { profiles: out } : {};
}

/** The gateway resolves presets from config.yaml; settings.presets is the pre-config.yaml map. */
function targetOf(res: DecideResponse, plan: RoutePlan): PresetTarget | null {
  return res.route === undefined
    ? presetTarget(plan.settings.presets, res.action)
    : routeTarget(res.route, plan.profiles);
}

async function route(
  deps: HookDeps,
  request: CreateRequest,
  signal: AbortSignal,
  usage: UsageLinks | undefined,
  paseo: ProfileSource | undefined,
): Promise<CreateRequest | undefined> {
  const plan = await routePlan(deps, request, paseo);
  if (plan === undefined) {
    return undefined;
  }
  return plan.mode === 'act'
    ? routeAct(plan, deps, request, signal, usage)
    : routeShadow(plan, request, usage);
}

async function routePlan(
  deps: HookDeps,
  request: CreateRequest,
  paseo: ProfileSource | undefined,
): Promise<RoutePlan | undefined> {
  // Internal helper agents (commit messages, titles) are not user tasks.
  if (request.config.internal === true || deps.gatewayKnownDown?.() === true) {
    return undefined;
  }
  const settings = await deps.settings();
  const mode = settings.modes[ROUTING_POLICY];
  const input = buildRoutingInput(request.config.cwd, request.config.title);
  if (mode === 'off' || input === null) {
    return undefined;
  }
  const gateway = await deps.gateway();
  if (gateway === null) {
    return undefined;
  }
  const profiles = await loadProfiles(paseo);
  return {
    mode,
    settings,
    gateway,
    profiles,
    body: {
      harness: 'paseo',
      input: { ...input },
      models: routingModels(request.config, settings.presets, profiles),
    },
  };
}

function routeShadow(
  plan: RoutePlan,
  request: CreateRequest,
  usage: UsageLinks | undefined,
): undefined {
  // Shadow: nothing will be applied, so never make agent creation wait. The gateway logs it.
  const pending = plan.gateway
    .decide(ROUTING_POLICY, plan.body, { timeoutMs: SHADOW_TIMEOUT_MS })
    .catch(() => null);
  usage?.creating(
    request.config.cwd,
    request.config.title,
    pending.then((r) => r?.decisionId ?? null),
  );
  return undefined;
}

async function routeAct(
  plan: RoutePlan,
  deps: HookDeps,
  request: CreateRequest,
  signal: AbortSignal,
  usage: UsageLinks | undefined,
): Promise<CreateRequest | undefined> {
  const pending = plan.gateway.decide(ROUTING_POLICY, plan.body, {
    timeoutMs: ROUTING_BUDGET_MS,
    signal,
  });
  usage?.creating(
    request.config.cwd,
    request.config.title,
    pending.then(
      (r) => r?.decisionId ?? null,
      () => null,
    ),
  );
  const res = await pending;
  if (res === null || !pluginEnforces(res, plan.mode)) {
    return undefined;
  }
  const target = targetOf(res, plan);
  if (target === null) {
    return undefined;
  }
  return applyRouteTarget(deps, request, res, target);
}

function applyRouteTarget(
  deps: HookDeps,
  request: CreateRequest,
  res: DecideResponse,
  target: PresetTarget,
): CreateRequest | undefined {
  // A preset's or profile's mode applies only when the creator left modeId unset.
  const pinned = (request.config.modeId ?? '').trim() !== '';
  if (pinned && target.provider !== request.config.provider) {
    deps.log('routing skipped: caller pinned mode on another provider');
    return undefined;
  }
  const applied = pinned ? { ...target, modeId: '' } : target;
  deps.log(`routing ${res.action} → ${target.provider}/${target.model} (${res.decisionId})`);
  return { ...request, config: applyPreset(request.config, applied) };
}
