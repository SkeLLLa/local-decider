import type { LogRecord, ShadowRecord, UsageRecord } from '@local-decider/core';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ShadowLog } from '../src/shadow.ts';
import { computeStats, formatStats, type PolicyStats } from '../src/stats.ts';
import { tempPaths } from './helpers.ts';

function decision(
  id: string,
  answer: string,
  p: number,
  extra: Partial<ShadowRecord> = {},
): ShadowRecord {
  const other = answer === 'allow' ? 'ask' : 'allow';
  return {
    kind: 'decision',
    ts: '2026-11-10T00:00:00.000Z',
    decisionId: id,
    harness: 'cli',
    policy: 'permission',
    mode: 'shadow',
    inputHash: 'h',
    answers: {
      verdict: {
        type: 'choice',
        answer,
        probabilities: { [answer]: p, [other]: 1 - p },
        confidence: 2 * p - 1,
      },
    },
    action: answer,
    enforced: false,
    engine: 'fake',
    model: 'm',
    latencyMs: 100,
    ...extra,
  };
}

describe('computeStats', () => {
  it('computes agreement, Brier and reliability from joined outcomes', () => {
    const records: LogRecord[] = [
      decision('a', 'allow', 0.99),
      decision('b', 'allow', 0.6),
      decision('c', 'ask', 0.9, { error: 'boom', latencyMs: 5 }),
      { kind: 'outcome', ts: 't', decisionId: 'a', outcome: 'allow', source: 'user' },
      { kind: 'outcome', ts: 't', decisionId: 'b', outcome: 'ask', source: 'user' },
      { kind: 'outcome', ts: 't', decisionId: 'b', outcome: 'allow', source: 'user' },
      { kind: 'outcome', ts: 't', decisionId: 'zzz', outcome: 'allow', source: 'user' },
    ];
    const [s] = computeStats(records);
    assert.ok(s);
    assert.equal(s.decisions, 3);
    assert.equal(s.errors, 1);
    assert.equal(s.labelled, 2);
    assert.equal(s.agreement, 1, 'the latest outcome wins');
    assert.ok(Math.abs((s.brier ?? 0) - (2 * 0.01 ** 2 + 2 * 0.4 ** 2) / 2) < 1e-9);
    assert.equal(s.latencyP50Ms, 100);
    assert.deepEqual(
      s.reliability.map((b) => b.range),
      ['0.00-0.50', '0.95-1.00'],
    );
    assert.match(formatStats([s]), /agreement 100\.0%/);
  });

  it('reports an empty log', () => {
    assert.equal(formatStats(computeStats([])), 'No decisions logged yet.');
  });
});

function usage(decisionId: string, turnId: string, extra: Partial<UsageRecord> = {}): UsageRecord {
  return {
    kind: 'usage',
    ts: '2026-11-10T00:01:00.000Z',
    decisionId,
    turnId,
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 100_000,
    ...extra,
  };
}

function routing(id: string, extra: Partial<ShadowRecord>): ShadowRecord {
  return decision(id, 'allow', 0.9, { policy: 'routing', action: 'route:fast', ...extra });
}

describe('savings', () => {
  const records: LogRecord[] = [
    routing('a', { requestedModel: 'claude/opus', routedModel: 'claude/haiku' }),
    // No requested model: the usage report's model stands in for it in shadow.
    routing('b', { routedModel: 'claude/haiku' }),
    routing('c', { requestedModel: 'claude/opus', routedModel: 'claude/opus' }),
    routing('d', { requestedModel: 'claude/opus', routedModel: 'claude/haiku', enforced: true }),
    routing('e', { requestedModel: 'claude/opus', routedModel: 'claude/haiku' }),
    usage('a', '1'),
    usage('a', '1'),
    usage('a', '2'),
    usage('b', '1', { model: 'claude/opus' }),
    usage('c', '1'),
    usage('d', '1', { model: 'claude/haiku' }),
  ];

  it('reports tokens moved without a price table', () => {
    const [s] = computeStats(records);
    const potential = s?.savings?.potential;
    assert.equal(potential?.tasks, 3, 'e has no usage');
    assert.equal(potential.moved, 2);
    assert.deepEqual(potential.tokens, { input: 3_000_000, cachedInput: 0, output: 300_000 });
    assert.equal(potential.savedUsd, undefined);
    assert.equal(s?.savings?.realized.moved, 1);
    assert.match(
      formatStats(computeStats(records)),
      /potential .*2\/3 tasks on another model, 3\.3M tokens$/m,
    );
  });

  it('prices moves when a price table is configured', () => {
    const pricing = { 'claude/opus': { input: 5, output: 25 }, 'haiku': { input: 1, output: 5 } };
    const [s] = computeStats(records, pricing);
    // (5 - 1) * 3 + (25 - 5) * 0.3 = 18
    assert.ok(Math.abs((s?.savings?.potential.savedUsd ?? 0) - 18) < 1e-9);
    assert.ok(Math.abs((s?.savings?.realized.savedUsd ?? 0) - 6) < 1e-9);
    assert.match(formatStats([s as PolicyStats]), /\$18\.00 saved/);
  });

  it('counts time spent on prompts the policy would have allowed', () => {
    const [s] = computeStats([
      decision('p', 'allow', 0.99),
      decision('q', 'allow', 0.99),
      decision('r', 'ask', 0.9),
      {
        kind: 'outcome',
        ts: '2026-11-10T00:00:04.000Z',
        decisionId: 'p',
        outcome: 'allow',
        source: 'user',
      },
      {
        kind: 'outcome',
        ts: '2026-11-10T00:00:10.000Z',
        decisionId: 'q',
        outcome: 'deny',
        source: 'user',
      },
      {
        kind: 'outcome',
        ts: '2026-11-10T00:00:10.000Z',
        decisionId: 'r',
        outcome: 'allow',
        source: 'user',
      },
    ]);
    assert.deepEqual(s?.promptTime, {
      answered: 2,
      userAllowed: 1,
      waitTotalMs: 14_000,
      waitP50Ms: 4000,
    });
    assert.equal(s?.savings, undefined);
  });
});

describe('ShadowLog', () => {
  it('appends daily JSONL and skips malformed lines when reading', () => {
    const { logs } = tempPaths();
    const log = new ShadowLog(logs);
    assert.deepEqual(log.read(), []);
    log.append(decision('a', 'allow', 0.9));
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, 'decisions-2026-11-10.jsonl'), 'garbage\n{"kind":"other"}\n\n');
    assert.equal(log.read().length, 1);
    assert.equal(log.dir, logs);
  });
});
