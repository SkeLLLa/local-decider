import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRefLike, AppendItem, HookDeps, PaseoLike } from '../server/deps.ts';
import type { DecideResponse, UsageReport } from '../shared/decision.ts';
import type { Gateway } from '../shared/gateway.ts';
import type { DeciderSettings } from '../shared/settings.ts';

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ld-${prefix}-`));
}

export function settings(overrides: Partial<DeciderSettings> = {}): DeciderSettings {
  return {
    gatewayUrl: 'http://127.0.0.1:8765',
    modes: { 'turn-outcome': 'shadow', 'permission': 'shadow', 'routing': 'shadow' },
    presets: {
      fast: { model: '', modeId: '' },
      standard: { model: '', modeId: '' },
      deep: { model: '', modeId: '' },
    },
    injectMcp: false,
    preloadOnStart: false,
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
  readonly usage: UsageReport[];
  /** Every mutating engine call, by name, with its input. */
  readonly posts: { name: string; input: unknown }[];
}

export function fakeGateway(
  decide: (policy: string) => DecideResponse | null | Promise<DecideResponse | null>,
): FakeGateway {
  const calls: FakeGateway['calls'] = [];
  const outcomes: FakeGateway['outcomes'] = [];
  const usage: UsageReport[] = [];
  const posts: FakeGateway['posts'] = [];
  const record =
    (name: string) =>
    async (input: unknown): Promise<{ ok: true; body: unknown }> => {
      posts.push({ name, input });
      return { ok: true, body: {} };
    };
  return {
    baseUrl: 'http://127.0.0.1:8765',
    bearer: false,
    calls,
    outcomes,
    usage,
    posts,
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
    async reportUsage(report) {
      usage.push(report);
      return true;
    },
    health: async () => ({ status: 'ok', engine: 'strands-decider', model: 'm', p50Ms: 100 }),
    engines: async () => ({}),
    stats: async () => ({}),
    selectEngine: record('selectEngine'),
    setSelectionMode: async (mode) => record('setSelectionMode')({ mode }),
    downloadModel: record('downloadModel'),
    validateEngine: record('validateEngine'),
    saveEngineConnection: record('saveEngineConnection'),
    discoverServers: record('discoverServers'),
    setPath: async (key, value) => record('setPath')({ key, value }),
    engineLoad: record('engineLoad'),
    setLifecycle: record('setLifecycle'),
    setPolicyMode: record('setPolicyMode'),
    policies: async () => [
      {
        id: 'permission',
        mode: 'shadow',
        description: 'p',
        routes: [],
        variants: ['permission'],
        thresholds: [
          {
            key: 'verdict.allow',
            question: 'verdict',
            answer: 'allow',
            action: 'allow',
            kind: 'minProbability',
            default: 0.95,
            value: 0.9,
            floor: 0.8,
          },
        ],
      },
      {
        id: 'routing',
        mode: 'act',
        description: 'Tiers.',
        routes: ['fast', 'deep'],
        variant: 'routing-budget',
        variants: ['routing', 'routing-budget'],
      },
      {
        id: 'routing-budget',
        description: 'Cheap first.',
        routes: ['cheap'],
        variantOf: 'routing',
      },
    ],
    setPolicyVariant: async (policy, variant) => record('setPolicyVariant')({ policy, variant }),
    setPolicyThresholds: async (policy, thresholds) =>
      record('setPolicyThresholds')({ policy, thresholds }),
    config: async () => ({
      file: '/home/u/.config/local-decider/config.yaml',
      config: { routing: { presets: { paseo: { cheap: { model: 'claude/haiku' } } } } },
    }),
    setRoutingPreset: async (update) => record('setRoutingPreset')(update),
    policyPrompt: async (policy) =>
      policy === 'routing'
        ? { prompt: '# Write a policy', cwd: '/home/u/.config/local-decider' }
        : null,
    reloadPolicies: async () => {
      posts.push({ name: 'reloadPolicies', input: {} });
      return { ok: true, body: { policies: ['permission', 'routing', 'routing-budget'] } };
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
