import type { OutcomeRecord, Policy, ShadowRecord } from '@local-decider/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PrecedentStore } from '../src/precedent.ts';

const SETTINGS = {
  from: 'subject',
  minAllows: 3,
  maxAgeDays: 14,
  sources: ['user', 'supervised'],
} satisfies NonNullable<Policy['precedent']>;

const NOW = Date.parse('2026-11-10T00:00:00.000Z');

function makeStore(now: () => number = () => NOW): PrecedentStore {
  return new PrecedentStore((id) => (id === 'permission' ? SETTINGS : undefined), now);
}

function decision(
  decisionId: string,
  key = 'subject-hash',
  action = 'ask',
  ts = new Date(NOW).toISOString(),
): ShadowRecord {
  return {
    kind: 'decision',
    ts,
    decisionId,
    harness: 'cli',
    policy: 'permission',
    mode: 'act',
    inputHash: 'state-hash',
    precedentKey: key,
    answers: {},
    action,
    enforced: true,
    engine: 'test',
    model: 'test',
    latencyMs: 1,
  };
}

function outcome(
  decisionId: string,
  answer = 'allow',
  source: OutcomeRecord['source'] = 'user',
  ts = new Date(NOW).toISOString(),
): OutcomeRecord {
  return { kind: 'outcome', ts, decisionId, outcome: answer, source };
}

describe('PrecedentStore', () => {
  it('tracks allow and deny labels so any deny can veto the threshold', () => {
    const store = makeStore();
    for (const id of ['a', 'b', 'c', 'd']) {
      store.noteDecision(decision(id));
      store.noteOutcome(outcome(id, id === 'd' ? 'deny' : 'allow'));
    }
    assert.deepEqual(store.tally('subject-hash'), { allows: 3, denies: 1 });
  });

  it('counts only outcomes for escalated decisions', () => {
    const store = makeStore();
    store.noteDecision(decision('auto-allow', 'subject-hash', 'allow'));
    store.noteOutcome(outcome('auto-allow'));
    assert.deepEqual(store.tally('subject-hash'), { allows: 0, denies: 0 });
  });

  it('accepts the first outcome per decision only', () => {
    const store = makeStore();
    store.noteDecision(decision('one'));
    store.noteOutcome(outcome('one', 'allow', 'harness'));
    store.noteOutcome(outcome('one', 'allow', 'user'));
    assert.deepEqual(store.tally('subject-hash'), { allows: 0, denies: 0 });
  });

  it('expires evidence after maxAgeDays and ignores old decisions', () => {
    let now = NOW;
    const store = makeStore(() => now);
    store.noteDecision(decision('recent'));
    store.noteOutcome(outcome('recent'));
    store.noteDecision(
      decision('old', 'subject-hash', 'ask', new Date(NOW - 15 * 86_400_000).toISOString()),
    );
    store.noteOutcome(outcome('old'));
    now += 15 * 86_400_000;
    assert.deepEqual(store.tally('subject-hash'), { allows: 0, denies: 0 });
  });

  it('rebuilds tallies from decision and outcome records', () => {
    const store = makeStore();
    store.rebuild([
      decision('one'),
      outcome('one'),
      decision('two'),
      outcome('two', 'deny'),
      decision('not-escalated', 'subject-hash', 'allow'),
      outcome('not-escalated'),
    ]);
    assert.deepEqual(store.tally('subject-hash'), { allows: 1, denies: 1 });
  });
});
