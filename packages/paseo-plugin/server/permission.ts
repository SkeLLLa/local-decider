/**
 * `agent.permission.before` → `permission`. Auto-allows only when the gateway enforced an `allow`
 * AND the plugin's permission mode is `act`. Never denies: everything else stays pending for the
 * user (ADR-0005). `agent.permission.after` reports what was decided as the outcome.
 */
import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from '@getpaseo/protocol/agent-types';

import { ROW_KIND, ROW_VERSION } from '../shared/constants.ts';
import type { Gateway } from '../shared/gateway.ts';
import { rowId, toRowData } from '../shared/row.ts';
import { Background, detach } from './background.ts';
import { errorText, type HookDeps } from './deps.ts';
import { buildPermissionInput, transcript, mergeAssistantChunks } from './history.ts';
import { BoundedMap } from './limits.ts';
import { pluginEnforces, type HookCtx } from './turn.ts';

const PERMISSION_POLICY = 'permission';
const HISTORY_LIMIT = 20;
/** Detached from the hook; the request stays pending for the user meanwhile. */
const DECIDE_TIMEOUT_MS = 60_000;

export interface PermissionEvent {
  readonly agent: PluginHookAgent;
  readonly request: AgentPermissionRequest;
}

export interface PermissionResolvedEvent {
  readonly agent: PluginHookAgent;
  readonly requestId: string;
  readonly resolution: AgentPermissionResponse;
}

interface Pending {
  readonly decisionId: string;
  autoAllowed: boolean;
}

/** The allow response, picking the request's own primary allow action when it offers one. */
export function allowResponse(request: AgentPermissionRequest): AgentPermissionResponse {
  const actions = (request.actions ?? []).filter((a) => a.behavior === 'allow');
  const action = actions.find((a) => a.variant === 'primary') ?? actions[0];
  return action === undefined
    ? { behavior: 'allow' }
    : { behavior: 'allow', selectedActionId: action.id };
}

export function createPermissionHandlers(
  deps: HookDeps,
  background: Background = new Background(),
): {
  before: (event: PermissionEvent, ctx: HookCtx) => Promise<void>;
  after: (event: PermissionResolvedEvent) => Promise<void>;
} {
  const pending = new BoundedMap<Pending>(500);

  // Returns at once: the request stays pending for the user while the decision runs detached.
  const before = async (event: PermissionEvent, ctx: HookCtx): Promise<void> => {
    detach(
      background,
      (m) => deps.log(m),
      `permission for ${event.agent.id}`,
      async (signal) => handleRequest(deps, pending, event, { paseo: ctx.paseo, signal }),
    );
  };

  const after = async (event: PermissionResolvedEvent): Promise<void> => {
    // Only a human answer is ground truth; our own auto-allow would confirm itself.
    const entry = pending.take(`${event.agent.id}:${event.requestId}`);
    if (entry === undefined || entry.autoAllowed) {
      return;
    }
    try {
      const gateway = await deps.gateway();
      await gateway?.reportOutcome(entry.decisionId, event.resolution.behavior, 'user');
    } catch (error) {
      deps.log(`permission outcome not reported: ${errorText(error)}`);
    }
  };

  return { before, after };
}

async function handleRequest(
  deps: HookDeps,
  pending: BoundedMap<Pending>,
  event: PermissionEvent,
  ctx: HookCtx,
): Promise<void> {
  // Questions, plan approvals and mode switches need a human answer, not an allow.
  if (event.request.kind !== 'tool') {
    return;
  }
  const settings = await deps.settings();
  const mode = settings.modes[PERMISSION_POLICY];
  const gateway = await deps.gateway();
  if (mode === 'off' || gateway === null) {
    return;
  }
  const agent = ctx.paseo.agents.ref(event.agent.id);
  const history = await recentHistory(agent);
  const res = await decidePermission(gateway, event, history, ctx.signal);
  if (res === null) {
    return;
  }
  const key = `${event.agent.id}:${event.request.id}`;
  const entry: Pending = { decisionId: res.decisionId, autoAllowed: false };
  pending.set(key, entry);
  const enforced = pluginEnforces(res, mode);
  if (enforced && res.action === 'allow') {
    entry.autoAllowed = await tryAllow(agent, event.request);
  }
  const data = toRowData(res, {
    source: 'permission',
    enforced,
    applied: entry.autoAllowed,
    note: `${event.request.name}${entry.autoAllowed ? ' auto-allowed' : ''}`,
  });
  await agent.timeline.append({
    type: 'plugin',
    id: rowId('permission', event.request.id),
    kind: ROW_KIND,
    version: ROW_VERSION,
    data: { ...data },
  });
}

async function recentHistory(
  agent: ReturnType<HookCtx['paseo']['agents']['ref']>,
): Promise<string> {
  try {
    const page = await agent.timeline.refetch({ direction: 'tail', limit: HISTORY_LIMIT });
    const items = page.entries.map((e) => e.item).filter((i) => i.type !== 'plugin');
    return transcript(mergeAssistantChunks(items), 6000);
  } catch {
    return '';
  }
}

async function decidePermission(
  gateway: Gateway,
  event: PermissionEvent,
  history: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<Gateway['decide']>>> {
  const input = buildPermissionInput(event.agent.cwd, history, event.request);
  return gateway.decide(
    PERMISSION_POLICY,
    { harness: 'paseo', sessionId: event.agent.id, input: { ...input } },
    { timeoutMs: DECIDE_TIMEOUT_MS, signal },
  );
}

/** True when our allow went through; false when the user (or anyone) answered first. */
async function tryAllow(
  agent: ReturnType<HookCtx['paseo']['agents']['ref']>,
  request: AgentPermissionRequest,
): Promise<boolean> {
  try {
    await agent.respondToPermission({ requestId: request.id, response: allowResponse(request) });
    return true;
  } catch {
    // Already resolved: the user answered while the gateway was deciding. Benign.
    return false;
  }
}
