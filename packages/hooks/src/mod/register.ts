/**
 * Claude Code mod entry (bundled to `plugins/local-decider/hooks/local-decider-auto-mode.mjs`): in auto mode, a
 * plain permission `ask` goes to the local decider before the server-side classifier. It only
 * ever upgrades such an ask to `allow`, and only when the `claude-auto` scope is in `act` mode;
 * every other path returns what Claude Code decided. A failure skips the hook, so the classifier
 * decides as if the mod were not installed.
 */
import type { DecideResponse } from '@ziptie-soft/local-decider-core';

import {
  callAllows,
  classifierVerdict,
  deterministicBlock,
  isPlainAsk,
  mayAct,
  reasonOf,
  versionAtLeast,
  type CallInfo,
} from './check.ts';
import { decide, getCall, postOutcome, readEnv, within, type ModEnv } from './gateway.ts';
import { buildInput } from './input.ts';
import type {
  ModApi,
  Register,
  ToolCallHook,
  ToolCallResult,
  ToolCheckEvent,
  ToolCheckHook,
  ToolCheckResult,
} from './types.ts';

const PENDING_MAX = 500;

/** What `check` sent to the gateway for a call, until `observe` sees the call's result. */
interface Pending {
  readonly res: Promise<DecideResponse | null>;
  readonly env: ModEnv;
  /** The mod returned `allow` for this call (the guard may still have discarded it). */
  readonly applied: boolean;
}

/** Insertion-ordered map capped at `PENDING_MAX` entries, oldest dropped first. */
class PendingStore {
  readonly #entries = new Map<string, Pending>();

  set(id: string, pending: Pending): void {
    this.#entries.delete(id);
    this.#entries.set(id, pending);
    if (this.#entries.size > PENDING_MAX) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) {
        this.#entries.delete(oldest);
      }
    }
  }

  take(id: string): Pending | undefined {
    const pending = this.#entries.get(id);
    this.#entries.delete(id);
    return pending;
  }
}

async function versionOk($: ModApi): Promise<boolean> {
  try {
    return versionAtLeast(await $.session.version());
  } catch {
    return false;
  }
}

/** The `permission` request for this call, sent as the `claude-auto` scope. */
async function ask(
  $: ModApi,
  env: ModEnv,
  e: ToolCheckEvent,
  cwd: string,
  id: string,
): Promise<DecideResponse | null> {
  const subagent = e.agentId !== undefined;
  const messages = subagent ? undefined : await $.session.messages();
  return decide($, env, 'permission', {
    harness: 'claude-code',
    sessionId: await $.session.id(),
    input: buildInput(e, cwd, messages),
    workspace: { cwd },
    scope: 'claude-auto',
    call: { id, agent: subagent },
  });
}

interface Gate {
  readonly env: ModEnv;
  readonly call: CallInfo;
  readonly cwd: string;
}

/** Everything that must hold before the decider is consulted at all; null passes through. */
async function gate($: ModApi, e: ToolCheckEvent, id: string): Promise<Gate | null> {
  if (!(await versionOk($))) {
    return null;
  }
  const env = await readEnv($);
  if (env.off || env.hostPermission) {
    return null;
  }
  const call = await within($, env.budgetMs, getCall($, env, id));
  if (call === null || !callAllows(call)) {
    return null;
  }
  const cwd = await $.session.cwd();
  return deterministicBlock(e.tool, e.input, cwd) === null ? { env, call, cwd } : null;
}

async function upgrade(
  $: ModApi,
  e: ToolCheckEvent,
  decided: ToolCheckResult,
): Promise<ToolCheckResult> {
  const id = e.tool_use_id ?? '';
  const g = await gate($, e, id);
  if (g === null) {
    return decided;
  }
  const res = ask($, g.env, e, g.cwd, id).catch(() => null);
  if (!mayAct(g.call, e)) {
    pending.set(id, { res, env: g.env, applied: false });
    return decided;
  }
  const r = await within($, g.env.budgetMs, res);
  const allow = r !== null && r.enforced && r.action === 'allow';
  pending.set(id, { res, env: g.env, applied: allow });
  return allow ? { decision: 'allow', reason: reasonOf(r) } : decided;
}

/** Calls the mod sent to the gateway; exported so tests can inspect and drain it. */
export const pending = new PendingStore();

/** `tool.check`: upgrade a plain auto-mode `ask` when the local decider allows it. */
export async function check(
  $: ModApi,
  e: ToolCheckEvent,
  next: Parameters<ToolCheckHook>[2],
): Promise<ToolCheckResult> {
  const decided = await next(e);
  return isPlainAsk(e, decided, next.origin) ? upgrade($, e, decided) : decided;
}

/**
 * `tool.call`: record what the classifier decided. A call the mod allowed shows no classifier
 * verdict unless the guard discarded the allow (host sessions), so only a denial is recorded for
 * those.
 */
export async function observe(
  $: ModApi,
  e: ToolCheckEvent,
  next: Parameters<ToolCallHook>[2],
): Promise<ToolCallResult> {
  const result = await next(e);
  const p = e.tool_use_id === undefined ? undefined : pending.take(e.tool_use_id);
  if (next.signal?.aborted === true) {
    return result;
  }
  const verdict = classifierVerdict(result);
  if (p !== undefined && verdict !== null && !(p.applied && verdict === 'allow')) {
    void p.res.then(async (r) =>
      r === null ? undefined : postOutcome($, p.env, r.decisionId, verdict),
    );
  }
  return result;
}

export function register(on: Register): void {
  // Literal filters: the bundler turns a top-level `const` into `var`, which the validator skips.
  on('tool.check', { tool: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, check);
  on('tool.call', { tool: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, observe);
}
