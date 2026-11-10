/**
 * Token usage of agents that a routing decision created, reported after each turn to
 * `POST /v1/usage`, so the gateway's stats can show what routing saved (enforced) or would have
 * saved (shadow). Only token counts and model ids leave the daemon. Links live in memory, so a
 * daemon restart stops reporting for agents created before it.
 */
import type { PluginHookAgent } from '@getpaseo/plugin/server';

import type { UsageReport } from '../shared/decision.ts';
import { errorText, type AgentRefLike, type HookDeps, type PaseoLike } from './deps.ts';
import { BoundedMap, BoundedSet } from './limits.ts';

/** `agent.create.after` follows `agent.create.before` at once; older pending links are stale. */
const LINK_TTL_MS = 60_000;
const REPORT_TIMEOUT_MS = 5000;

interface PendingLink {
  readonly decision: Promise<string | null>;
  readonly at: number;
}

export class UsageLinks {
  readonly #creating = new BoundedMap<PendingLink>(100);
  readonly #agents = new BoundedMap<Promise<string | null>>(2000);
  readonly #seen = new BoundedSet(5000);
  /** Agent id → the last usage reported, to skip a turn that reported none of its own. */
  readonly #last = new BoundedMap<string>(2000);
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** `agent.create.before`: the routing decision (its id, or null) for the agent being created. */
  creating(cwd: string, title: string | null | undefined, decision: Promise<string | null>): void {
    this.#creating.set(linkKey(cwd, title), { decision, at: this.#now() });
  }

  /** `agent.create.after`: attach the pending decision to the new agent's id. */
  created(agent: Pick<PluginHookAgent, 'id' | 'cwd' | 'title'>): void {
    const pending = this.#creating.take(linkKey(agent.cwd, agent.title));
    if (pending !== undefined && this.#now() - pending.at < LINK_TTL_MS) {
      this.#agents.set(agent.id, pending.decision);
    }
  }

  /** `agent.turn.after`: report the finished turn's usage when the agent has a decision. */
  async turnEnded(
    deps: Pick<HookDeps, 'gateway' | 'log'>,
    event: { agent: Pick<PluginHookAgent, 'id'>; turnId: string | null },
    paseo: PaseoLike,
  ): Promise<void> {
    const decision = this.#agents.get(event.agent.id);
    if (decision === undefined) {
      return;
    }
    try {
      const decisionId = await decision;
      const agent = paseo.agents.ref(event.agent.id);
      if (decisionId === null || agent.refresh === undefined) {
        return;
      }
      await agent.refresh();
      const report = usageReport(decisionId, event.turnId, agent);
      if (report === null || !this.#fresh(event.agent.id, event.turnId, report)) {
        return;
      }
      const gateway = await deps.gateway();
      await gateway?.reportUsage(report, { timeoutMs: REPORT_TIMEOUT_MS });
    } catch (error) {
      deps.log(`usage not reported: ${errorText(error)}`);
    }
  }

  /** False for a turn already reported, or usage identical to the agent's previous report. */
  #fresh(agentId: string, turnId: string | null, report: UsageReport): boolean {
    if (turnId !== null && !this.#seen.add(`${agentId}:${turnId}`)) {
      return false;
    }
    const counts = `${String(report.inputTokens)}/${String(report.cachedInputTokens)}/${String(report.outputTokens)}`;
    if (this.#last.get(agentId) === counts) {
      return false;
    }
    this.#last.set(agentId, counts);
    return true;
  }
}

function linkKey(cwd: string, title: string | null | undefined): string {
  return `${cwd}\n${(title ?? '').trim()}`;
}

function tokens(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** `provider/model` the agent runs on, when Paseo knows it. */
function modelOf(info: AgentRefLike['runtimeInfo']): string | undefined {
  return typeof info?.model === 'string' && info.model !== ''
    ? `${info.provider}/${info.model}`
    : undefined;
}

/** Paseo's `lastUsage` is the last turn's usage (provider-reported); null without token counts. */
export function usageReport(
  decisionId: string,
  turnId: string | null,
  agent: Pick<AgentRefLike, 'lastUsage' | 'runtimeInfo'>,
): UsageReport | null {
  const usage = agent.lastUsage;
  const input = tokens(usage?.inputTokens);
  const output = tokens(usage?.outputTokens);
  if (usage === null || usage === undefined || input === undefined || output === undefined) {
    return null;
  }
  const model = modelOf(agent.runtimeInfo);
  const cost = usage.totalCostUsd;
  return {
    decisionId,
    ...(turnId === null ? {} : { turnId }),
    ...(model === undefined ? {} : { model }),
    inputTokens: input,
    cachedInputTokens: tokens(usage.cachedInputTokens) ?? 0,
    outputTokens: output,
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
  };
}
