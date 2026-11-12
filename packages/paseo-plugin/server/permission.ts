/**
 * `agent.permission.before` → `permission`. Auto-allows only when the gateway enforced an `allow`
 * AND the plugin's permission mode is `act`. Never denies: everything else stays pending for the
 * user (ADR-0005). `agent.permission.after` reports the user's answer (`allow`, or a neutral
 * `decline` / `interrupted`) as the ground-truth outcome, redraws the row with it, and registers
 * the row for label chips, which can later report `unsafe` (`labels.ts`). Paseo does not await `before`, so the user can answer
 * before, while or after the decision lands; `settleUser` handles each order exactly once.
 */
import type { PluginHookAgent } from '@getpaseo/plugin/server';
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
} from '@getpaseo/protocol/agent-types';

import type { DecideResponse } from '../shared/decision.ts';
import type { Gateway } from '../shared/gateway.ts';
import { rowVisible, toRowData, type DecisionRow } from '../shared/row.ts';
import { Background, detach } from './background.ts';
import { errorText, type HookDeps } from './deps.ts';
import {
  buildPermissionInput,
  firstOfType,
  mergeAssistantChunks,
  taskText,
  transcript,
  type RecentContext,
} from './history.ts';
import { LabelRegistry } from './labels.ts';
import { BoundedMap } from './limits.ts';
import { appendRow } from './timeline.ts';
import { pluginEnforces, type HookCtx } from './turn.ts';

const PERMISSION_POLICY = 'permission';
const HISTORY_LIMIT = 20;
const TIMELINE_FETCH_LIMIT = 100;
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
  readonly agentId: string;
  readonly supervised: boolean;
  decisionId: string | null;
  /** True from the moment our allow is sent: its own `after` is not a user outcome. */
  autoAllowed: boolean;
  /** The user's answer as an outcome (`allow|decline|interrupted`), once reported. */
  resolution: string | null;
  /** Epoch ms (daemon clock) of the user's answer or our auto-allow; null until then. */
  answeredAt: number | null;
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

/** The user's answer as an outcome: a decline is neutral until labelled (ADR-0006 addendum). */
function userOutcome(resolution: AgentPermissionResponse): 'allow' | 'decline' | 'interrupted' {
  if (resolution.behavior === 'allow') {
    return 'allow';
  }
  return resolution.interrupt === true ? 'interrupted' : 'decline';
}

export interface PermissionOptions {
  readonly labels?: LabelRegistry;
  readonly now?: () => number;
}

interface PermissionState {
  readonly pending: BoundedMap<Pending>;
  readonly firstRequests: BoundedMap<string>;
  readonly labels: LabelRegistry;
  readonly now: () => number;
}

export function createPermissionHandlers(
  deps: HookDeps,
  background: Background = new Background(),
  options: PermissionOptions = {},
): {
  before: (event: PermissionEvent, ctx: HookCtx) => Promise<void>;
  after: (event: PermissionResolvedEvent) => Promise<void>;
} {
  const state: PermissionState = {
    pending: new BoundedMap<Pending>(500),
    firstRequests: new BoundedMap<string>(500),
    labels: options.labels ?? new LabelRegistry(),
    now: options.now ?? Date.now,
  };

  // Returns at once: the request stays pending for the user while the decision runs detached.
  const before = async (event: PermissionEvent, ctx: HookCtx): Promise<void> => {
    detach(
      background,
      (m) => deps.log(m),
      `permission for ${event.agent.id}`,
      async (signal) => handleRequest(deps, state, event, { paseo: ctx.paseo, signal }),
    );
  };

  const after = async (event: PermissionResolvedEvent): Promise<void> => {
    const entry = state.pending.take(`${event.agent.id}:${event.requestId}`);
    if (entry === undefined) {
      return;
    }
    entry.resolution = userOutcome(event.resolution);
    entry.answeredAt = state.now();
    await settleUser(deps, state, entry);
  };

  return { before, after };
}

async function handleRequest(
  deps: HookDeps,
  state: PermissionState,
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
    agentId: event.agent.id,
    supervised: event.agent.parentAgentId !== null,
    decisionId: null,
    autoAllowed: false,
    resolution: null,
    answeredAt: null,
    reported: false,
    row: null,
  };
  state.pending.set(`${event.agent.id}:${event.request.id}`, entry);
  const context = await recentContext(
    agent,
    event.agent.id,
    state.firstRequests,
    event.agent.title,
  );
  const res = await decidePermission(gateway, event, context, ctx.signal);
  if (res === null) {
    return;
  }
  entry.decisionId = res.decisionId;
  const enforced = pluginEnforces(res, mode);
  if (enforced && res.action === 'allow' && entry.resolution === null) {
    // Set before awaiting: `after` for our own allow can fire while the response is in flight.
    entry.autoAllowed = true;
    entry.autoAllowed = await tryAllow(agent, event.request);
    if (entry.autoAllowed) {
      entry.answeredAt = state.now();
    }
  }
  const data = permissionRow(res, event, entry, enforced);
  if (rowVisible(data, settings.rows.show)) {
    await drawRow(state, entry, data);
  }
  await settleUser(deps, state, entry);
}

function permissionRow(
  res: DecideResponse,
  event: PermissionEvent,
  entry: Pending,
  enforced: boolean,
): DecisionRow {
  return {
    ...toRowData(res, {
      source: 'permission',
      key: event.request.id,
      enforced,
      applied: entry.autoAllowed,
      note: `${event.request.name}${entry.autoAllowed ? ' auto-allowed' : ''}`,
    }),
    feedback: entry.autoAllowed ? null : entry.resolution,
    answeredAt: entry.autoAllowed || entry.resolution !== null ? entry.answeredAt : null,
  };
}

/** Draw through one place, so the label registry always matches the drawn row. */
async function drawRow(state: PermissionState, entry: Pending, row: DecisionRow): Promise<void> {
  await appendRow(entry.agent, row);
  entry.row = row;
  state.labels.note(entry.agentId, row);
}

/**
 * Once both the decision and the user's answer are known: report the answer as the `user`
 * outcome and redraw the row with it. Idempotent; a no-op for our own auto-allow.
 */
async function settleUser(deps: HookDeps, state: PermissionState, entry: Pending): Promise<void> {
  const resolution = entry.resolution;
  if (resolution === null || entry.autoAllowed || entry.decisionId === null) {
    return;
  }
  if (!entry.reported) {
    entry.reported = true;
    await reportUser(deps, entry.decisionId, resolution, entry.supervised);
  }
  const row = entry.row;
  if (row !== null && row.feedback === null) {
    try {
      await drawRow(state, entry, { ...row, feedback: resolution, answeredAt: entry.answeredAt });
    } catch (error) {
      deps.log(`permission row not updated: ${errorText(error)}`);
    }
  }
}

async function reportUser(
  deps: HookDeps,
  decisionId: string,
  resolution: string,
  supervised: boolean,
): Promise<void> {
  try {
    const gateway = await deps.gateway();
    await gateway?.reportOutcome(decisionId, resolution, supervised ? 'supervised' : 'user');
  } catch (error) {
    deps.log(`permission outcome not reported: ${errorText(error)}`);
  }
}

async function recentContext(
  agent: AgentRef,
  agentId: string,
  firstRequests: BoundedMap<string>,
  title: string | null | undefined,
): Promise<RecentContext> {
  let items: AgentTimelineItem[] = [];
  try {
    const page = await agent.timeline.refetch({ direction: 'tail', limit: TIMELINE_FETCH_LIMIT });
    items = page.entries.map((e) => e.item).filter((item) => item.type !== 'plugin');
    const first = firstOfType(items, 'user_message')?.text.trim();
    if (firstRequests.get(agentId) === undefined && first !== undefined && first !== '') {
      firstRequests.set(agentId, first);
    }
  } catch {
    // The cached first request and agent title still make useful task context when refetch fails.
  }
  const recent = mergeAssistantChunks(items.slice(-HISTORY_LIMIT));
  return {
    history: transcript(recent, 6000),
    task: taskText(items, firstRequests.get(agentId), title),
  };
}

async function decidePermission(
  gateway: Gateway,
  event: PermissionEvent,
  context: RecentContext,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<Gateway['decide']>>> {
  const input = buildPermissionInput(event.agent.cwd, context.history, context.task, event.request);
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
