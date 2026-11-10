import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';

import type { AgentRefLike, AppendItem, HookDeps, PaseoLike } from '../server/deps.ts';
import type { DecideResponse } from '../shared/decision.ts';
import type { Gateway } from '../shared/gateway.ts';
import type { DeciderSettings } from '../shared/settings.ts';

export function settings(overrides: Partial<DeciderSettings> = {}): DeciderSettings {
  return {
    gatewayUrl: 'http://127.0.0.1:8765',
    model: '',
    device: 'auto',
    keepModel: false,
    modes: { 'turn-outcome': 'shadow', 'permission': 'shadow', 'routing': 'shadow' },
    presets: {
      fast: { model: '', modeId: '' },
      standard: { model: '', modeId: '' },
      deep: { model: '', modeId: '' },
    },
    injectMcp: false,
    sidebar: { position: 'footer', label: 'full', press: 'popover' },
    rows: { show: 'all', details: true, feedback: true },
    ...overrides,
  };
}

export function response(overrides: Partial<DecideResponse> = {}): DecideResponse {
  return {
    decisionId: 'd-1',
    policy: 'turn-outcome',
    mode: 'shadow',
    action: 'log',
    enforced: false,
    answers: {
      outcome: {
        type: 'choice',
        answer: 'done',
        probabilities: { done: 0.9, stuck: 0.1 },
        confidence: 0.8,
      },
    },
    rule: 0,
    engine: 'strands-decider',
    model: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
    latencyMs: 120,
    cached: false,
    ...overrides,
  };
}

export interface FakeGateway extends Gateway {
  readonly calls: {
    policy: string;
    input: Readonly<Record<string, unknown>>;
    sessionId?: string;
  }[];
  readonly outcomes: { decisionId: string; outcome: string; source: string }[];
  readonly selections: { model: string; device: string }[];
}

export function fakeGateway(
  decide: (policy: string) => DecideResponse | null | Promise<DecideResponse | null>,
): FakeGateway {
  const calls: FakeGateway['calls'] = [];
  const outcomes: FakeGateway['outcomes'] = [];
  const selections: FakeGateway['selections'] = [];
  return {
    baseUrl: 'http://127.0.0.1:8765',
    calls,
    outcomes,
    selections,
    async decide(policy, request) {
      calls.push({
        policy,
        input: request.input,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      });
      return decide(policy);
    },
    async reportOutcome(decisionId, outcome, source) {
      outcomes.push({ decisionId, outcome, source });
      return true;
    },
    health: async () => ({ status: 'ok', engine: 'strands-decider', model: 'm', p50Ms: 100 }),
    models: async () => [],
    stats: async () => ({}),
    async selectEngine(selection) {
      selections.push(selection);
      return { ok: true };
    },
  };
}

export function deps(s: DeciderSettings, gateway: Gateway | null): HookDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    settings: async () => s,
    gateway: async () => gateway,
    log: (m) => logs.push(m),
  };
}

export interface FakeAgent extends AgentRefLike {
  readonly appended: AppendItem[];
  readonly responses: unknown[];
}

export function fakePaseo(
  items: readonly { item: AgentTimelineItem; turnId?: string }[],
  respond: () => Promise<void> = async () => {},
): PaseoLike & { agent: FakeAgent } {
  const appended: AppendItem[] = [];
  const responses: unknown[] = [];
  const agent: FakeAgent = {
    appended,
    responses,
    timeline: {
      refetch: async () => ({ entries: items }),
      append: async (item) => {
        appended.push(item);
        return { seq: appended.length, epoch: 'e' };
      },
    },
    respondToPermission: async (options) => {
      responses.push(options);
      await respond();
    },
  };
  return { agent, agents: { ref: () => agent } };
}

export const ctx = (paseo: PaseoLike): { paseo: PaseoLike; signal: AbortSignal } => ({
  paseo,
  signal: new AbortController().signal,
});
