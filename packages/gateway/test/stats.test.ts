import type { LogRecord, ShadowRecord } from '@local-decider/core';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ShadowLog } from '../src/shadow.ts';
import { computeStats, formatStats } from '../src/stats.ts';
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
