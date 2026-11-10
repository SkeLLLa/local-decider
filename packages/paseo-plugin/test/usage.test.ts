import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentRefLike, PaseoLike } from '../server/deps.ts';
import { routingModels } from '../server/routing.ts';
import { UsageLinks, usageReport } from '../server/usage.ts';
import { parsePolicyStats, promptTimeSummary, savingsSummary } from '../shared/stats.ts';
import { deps, fakeGateway, fakePaseo, response, settings } from './fakes.ts';

function paseoWithUsage(
  usage: NonNullable<AgentRefLike['lastUsage']>,
): PaseoLike & { refreshes: number } {
  const base = fakePaseo([]);
  const state = { refreshes: 0 };
  const agent: AgentRefLike = {
    ...base.agent,
    refresh: async () => {
      state.refreshes++;
    },
    lastUsage: usage,
    runtimeInfo: { provider: 'claude', model: 'claude-opus-4-6[1m]' },
  };
  return {
    agents: { ref: () => agent },
    get refreshes() {
      return state.refreshes;
    },
  };
}

const agent = { id: 'a-1', cwd: '/p', title: 'Rename foo' };

describe('usage links', () => {
  it('reports each turn of an agent a routing decision created, once', async () => {
    const gw = fakeGateway(() => response());
    const d = deps(settings(), gw);
    const links = new UsageLinks();
    links.creating('/p', 'Rename foo', Promise.resolve('d-9'));
    links.created(agent);
    const paseo = paseoWithUsage({
      inputTokens: 10,
      cachedInputTokens: 500,
      outputTokens: 40,
      totalCostUsd: 0.02,
    });
    await links.turnEnded(d, { agent, turnId: 't1' }, paseo);
    await links.turnEnded(d, { agent, turnId: 't1' }, paseo);
    // A later turn that reported no usage of its own leaves lastUsage unchanged: skipped.
    await links.turnEnded(d, { agent, turnId: 't2' }, paseo);
    assert.deepEqual(gw.usage, [
      {
        decisionId: 'd-9',
        turnId: 't1',
        model: 'claude/claude-opus-4-6[1m]',
        inputTokens: 10,
        cachedInputTokens: 500,
        outputTokens: 40,
        costUsd: 0.02,
      },
    ]);
  });

  it('ignores agents without a decision, stale links and failed decisions', async () => {
    const gw = fakeGateway(() => response());
    const d = deps(settings(), gw);
    let now = 0;
    const links = new UsageLinks(() => now);
    const paseo = paseoWithUsage({ inputTokens: 1, outputTokens: 1 });
    await links.turnEnded(d, { agent, turnId: 't1' }, paseo);
    links.creating('/p', 'Rename foo', Promise.resolve('d-1'));
    now = 120_000;
    links.created(agent);
    await links.turnEnded(d, { agent, turnId: 't1' }, paseo);
    links.creating('/p', 'Other', Promise.resolve(null));
    links.created({ ...agent, title: 'Other' });
    await links.turnEnded(d, { agent, turnId: 't1' }, paseo);
    assert.deepEqual(gw.usage, []);
    assert.equal(paseo.refreshes, 0);
  });

  it('needs token counts to build a report', () => {
    assert.equal(usageReport('d', null, { lastUsage: null }), null);
    assert.equal(usageReport('d', null, { lastUsage: { inputTokens: 5 } }), null);
    assert.deepEqual(usageReport('d', null, { lastUsage: { inputTokens: 5, outputTokens: 1 } }), {
      decisionId: 'd',
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 1,
    });
  });
});

describe('routing models', () => {
  it('maps the requested model and every mapped preset', () => {
    const presets = {
      fast: { model: 'claude/haiku', modeId: '' },
      deep: { model: '', modeId: '' },
    };
    assert.deepEqual(routingModels({ provider: 'claude', model: 'opus' }, presets), {
      requested: 'claude/opus',
      routes: { 'route:fast': 'claude/haiku' },
    });
    assert.deepEqual(routingModels({ provider: 'claude' }, presets), {
      routes: { 'route:fast': 'claude/haiku' },
    });
  });

  it('sends Paseo profile models so the gateway can resolve profile presets', () => {
    const profiles = [
      { id: 'reviewer', provider: 'claude', model: 'claude-sonnet-5-5' },
      { id: 'no-model', provider: 'codex' },
    ];
    assert.deepEqual(routingModels({ provider: 'claude', model: 'opus' }, {}, profiles), {
      requested: 'claude/opus',
      routes: {},
      profiles: { reviewer: 'claude/claude-sonnet-5-5' },
    });
  });
});

describe('savings stats', () => {
  it('reads savings and prompt time tolerantly and summarises them', () => {
    const [s, old] = parsePolicyStats([
      {
        policy: 'routing',
        decisions: 4,
        savings: {
          potential: {
            tasks: 3,
            moved: 2,
            tokens: { input: 3_000_000, cachedInput: 0, output: 300_000 },
            savedUsd: 18,
            unpricedMoves: 0,
          },
          realized: {
            tasks: 0,
            moved: 0,
            tokens: { input: 0, cachedInput: 0, output: 0 },
            unpricedMoves: 0,
          },
        },
        promptTime: { answered: 3, userAllowed: 2, waitTotalMs: 90_000 },
      },
      { policy: 'turn-outcome', decisions: 1, savings: 'nope' },
    ]);
    assert.ok(s?.savings);
    assert.equal(
      savingsSummary(s.savings.potential),
      '2/3 tasks · 3.3M tokens on another model · ~$18.00',
    );
    assert.equal(savingsSummary(s.savings.realized), '');
    assert.equal(promptTimeSummary(s.promptTime), '3 prompts · 1.5 min');
    assert.equal(old?.savings, null);
    assert.equal(promptTimeSummary(old?.promptTime ?? null), '');
  });
});
