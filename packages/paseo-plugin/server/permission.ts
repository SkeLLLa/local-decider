/**
 * `agent.permission.before` → `permission`. Auto-allows only when the gateway enforced an `allow`
 * AND the plugin's permission mode is `act`. Never denies: everything else stays pending for the
 * user (ADR-0005). `agent.permission.after` reports the user's Accept/Deny as the one ground-truth
 * outcome and redraws the row with it. Paseo does not await `before`, so the user can answer
 * before, while or after the decision lands; `settleUser` handles each order exactly once.
 */
import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from '@getpaseo/protocol/agent-types';

import { ROW_KIND, ROW_VERSION } from '../shared/constants.ts';
import type { Gateway } from '../shared/gateway.ts';
import { rowVisible, toRowData, type DecisionRow } from '../shared/row.ts';
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

type AgentRef = ReturnType<HookCtx['paseo']['agents']['ref']>;

/** Per-request state, from the moment the decision starts until the request is resolved. */
interface Pending {
  readonly agent: AgentRef;
  decisionId: string | null;
  /** True from the moment our allow is sent: its own `after` is not a user outcome. */
  autoAllowed: boolean;
  /** The user's Accept/Deny once `agent.permission.after` reported it. */
  resolution: string | null;
  reported: boolean;
  /** The row as last appended; null until appended, or when hidden. */
  row: DecisionRow | null;
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
    const entry = pending.take(`${event.agent.id}:${event.requestId}`);
    if (entry === undefined) {
      return;
    }
    entry.resolution = event.resolution.behavior;
    await settleUser(deps, entry);
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
  // Tracked before deciding, so a user answer that arrives first is not lost.
  const entry: Pending = {
    agent,
    decisionId: null,
    autoAllowed: false,
    resolution: null,
    reported: false,
    row: null,
  };
  pending.set(`${event.agent.id}:${event.request.id}`, entry);
  const history = await recentHistory(agent);
  const res = await decidePermission(gateway, event, history, ctx.signal);
  if (res === null) {
    return;
  }
  entry.decisionId = res.decisionId;
  const enforced = pluginEnforces(res, mode);
  if (enforced && res.action === 'allow' && entry.resolution === null) {
    // Set before awaiting: `after` for our own allow can fire while the response is in flight.
    entry.autoAllowed = true;
    entry.autoAllowed = await tryAllow(agent, event.request);
  }
  const data: DecisionRow = {
    ...toRowData(res, {
      source: 'permission',
      key: event.request.id,
      enforced,
      applied: entry.autoAllowed,
      note: `${event.request.name}${entry.autoAllowed ? ' auto-allowed' : ''}`,
    }),
    feedback: entry.autoAllowed ? null : entry.resolution,
  };
  if (rowVisible(data, settings.rows.show)) {
    await appendRow(agent, data);
    entry.row = data;
  }
  await settleUser(deps, entry);
}

/**
 * Once both the decision and the user's answer are known: report the answer as the `user`
 * outcome and redraw the row with it. Idempotent; a no-op for our own auto-allow.
 */
async function settleUser(deps: HookDeps, entry: Pending): Promise<void> {
  const resolution = entry.resolution;
  if (resolution === null || entry.autoAllowed || entry.decisionId === null) {
    return;
  }
  if (!entry.reported) {
    entry.reported = true;
    await reportUser(deps, entry.decisionId, resolution);
  }
  const row = entry.row;
  if (row !== null && row.feedback === null) {
    entry.row = { ...row, feedback: resolution };
    try {
      await appendRow(entry.agent, entry.row);
    } catch (error) {
      deps.log(`permission row not updated: ${errorText(error)}`);
    }
  }
}

async function reportUser(deps: HookDeps, decisionId: string, resolution: string): Promise<void> {
  try {
    const gateway = await deps.gateway();
    await gateway?.reportOutcome(decisionId, resolution, 'user');
  } catch (error) {
    deps.log(`permission outcome not reported: ${errorText(error)}`);
  }
}

async function appendRow(agent: AgentRef, data: DecisionRow): Promise<void> {
  await agent.timeline.append({
    type: 'plugin',
    id: data.rowId,
    kind: ROW_KIND,
    version: ROW_VERSION,
    data: { ...data },
  });
}

async function recentHistory(agent: AgentRef): Promise<string> {
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
async function tryAllow(agent: AgentRef, request: AgentPermissionRequest): Promise<boolean> {
  try {
    await agent.respondToPermission({ requestId: request.id, response: allowResponse(request) });
    return true;
  } catch {
    // Already resolved: the user answered while the gateway was deciding. Benign.
    return false;
  }
}
