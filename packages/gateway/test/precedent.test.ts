import type { OutcomeRecord, Policy, ShadowRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PrecedentStore } from '../src/precedent.ts';
import { makeShadowRecord } from './records.ts';

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
  return makeShadowRecord(decisionId, {
    ts,
    mode: 'act',
    inputHash: 'state-hash',
    precedentKey: key,
    action,
    enforced: true,
    engine: 'test',
    model: 'test',
  });
}

function outcome(
  decisionId: string,
  answer = 'allow',
  source: OutcomeRecord['source'] = 'user',
  ts = new Date(NOW).toISOString(),
): OutcomeRecord {
  return { kind: 'outcome', ts, decisionId, outcome: answer, source, verified: true };
}

function tally(store: PrecedentStore): unknown {
  return store.tally('subject-hash');
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

  it('ignores unverified outcomes without consuming the decision', () => {
    const store = makeStore();
    store.noteDecision(decision('forged'));
    store.noteOutcome({ ...outcome('forged'), verified: false });
    assert.deepEqual(store.tally('subject-hash'), { allows: 0, denies: 0 });
    store.noteOutcome({ ...outcome('forged'), source: 'unverified' });
    assert.deepEqual(store.tally('subject-hash'), { allows: 0, denies: 0 });
    store.noteOutcome(outcome('forged'));
    assert.deepEqual(store.tally('subject-hash'), { allows: 1, denies: 0 });
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

  describe('typed outcome labels', () => {
    const ZERO = { allows: 0, denies: 0 };

    it('ignores a decline and counts a later unsafe as one deny', () => {
      const store = makeStore();
      store.noteDecision(decision('d1'));
      store.noteOutcome(outcome('d1', 'decline'));
      assert.deepEqual(tally(store), ZERO);
      store.noteOutcome(outcome('d1', 'unsafe'));
      assert.deepEqual(tally(store), { allows: 0, denies: 1 });
    });

    it('counts an interrupted to deny correction', () => {
      const store = makeStore();
      store.noteDecision(decision('d1'));
      store.noteOutcome(outcome('d1', 'interrupted'));
      store.noteOutcome(outcome('d1', 'deny'));
      assert.deepEqual(tally(store), { allows: 0, denies: 1 });
    });

    it('never corrects towards allow', () => {
      const store = makeStore();
      store.noteDecision(decision('d1'));
      store.noteOutcome(outcome('d1', 'decline'));
      store.noteOutcome(outcome('d1', 'allow'));
      assert.deepEqual(tally(store), ZERO);
    });

    it('keeps an allow final', () => {
      const store = makeStore();
      store.noteDecision(decision('d1'));
      store.noteOutcome(outcome('d1', 'allow'));
      store.noteOutcome(outcome('d1', 'unsafe'));
      assert.deepEqual(tally(store), { allows: 1, denies: 0 });
    });

    it('counts a second correction once', () => {
      const store = makeStore();
      store.noteDecision(decision('d1'));
      for (const value of ['decline', 'unsafe', 'deny']) {
        store.noteOutcome(outcome('d1', value));
      }
      assert.deepEqual(tally(store), { allows: 0, denies: 1 });
    });

    it('lets an unsafe label veto a keyed auto-allow', () => {
      const store = makeStore();
      store.noteDecision(decision('auto', 'subject-hash', 'allow'));
      store.noteOutcome(outcome('auto', 'unsafe'));
      assert.deepEqual(tally(store), { allows: 0, denies: 1 });
    });

    it('does not let an allow outcome teach on an auto-allow', () => {
      const store = makeStore();
      store.noteDecision(decision('auto', 'subject-hash', 'allow'));
      store.noteOutcome(outcome('auto', 'allow'));
      assert.deepEqual(tally(store), ZERO);
    });

    it('treats a veto from an unlisted source as final without evidence', () => {
      const store = makeStore();
      store.noteDecision(decision('d1'));
      store.noteOutcome(outcome('d1', 'unsafe', 'harness'));
      store.noteOutcome(outcome('d1', 'unsafe', 'user'));
      assert.deepEqual(tally(store), ZERO);
    });

    it('vetoes after three allows', () => {
      const store = makeStore();
      for (const id of ['a', 'b', 'c']) {
        store.noteDecision(decision(id));
        store.noteOutcome(outcome(id));
      }
      store.noteDecision(decision('d'));
      store.noteOutcome(outcome('d', 'unsafe'));
      assert.deepEqual(tally(store), { allows: 3, denies: 1 });
    });

    it('rebuilds a correction', () => {
      const store = makeStore();
      store.rebuild([decision('d1'), outcome('d1', 'decline'), outcome('d1', 'unsafe')]);
      assert.deepEqual(tally(store), { allows: 0, denies: 1 });
    });

    it('keeps a neutral label with its decision under LRU pressure', () => {
      const store = makeStore();
      store.noteDecision(decision('d1', 'K1'));
      store.noteOutcome(outcome('d1', 'decline'));
      for (let i = 0; i < 10_001; i += 1) {
        store.noteDecision(decision(`n${String(i)}`, `N${String(i)}`));
        store.noteOutcome(outcome(`n${String(i)}`));
      }
      store.noteOutcome(outcome('d1', 'allow'));
      assert.deepEqual(store.tally('K1'), ZERO);
    });

    it('drops later outcomes of an evicted decision', () => {
      const store = makeStore();
      store.noteDecision(decision('d1', 'K1'));
      store.noteOutcome(outcome('d1', 'decline'));
      for (let i = 0; i < 10_000; i += 1) {
        store.noteDecision(decision(`n${String(i)}`, `N${String(i)}`));
      }
      store.noteOutcome(outcome('d1', 'unsafe'));
      assert.deepEqual(store.tally('K1'), ZERO);
    });

    it('does not let auto-allows evict pending asks', () => {
      const store = makeStore();
      store.noteDecision(decision('d1'));
      for (let i = 0; i < 10_001; i += 1) {
        store.noteDecision(decision(`a${String(i)}`, `A${String(i)}`, 'allow'));
      }
      store.noteOutcome(outcome('d1'));
      assert.deepEqual(tally(store), { allows: 1, denies: 0 });
    });

    it('expires a late correction from the earlier timestamp', () => {
      const day = 86_400_000;
      let now = NOW;
      const store = makeStore(() => now);
      store.noteDecision(decision('d1'));
      store.noteOutcome(outcome('d1', 'decline', 'user', new Date(NOW + day).toISOString()));
      now = NOW + 13 * day;
      store.noteOutcome(outcome('d1', 'unsafe', 'user', new Date(now).toISOString()));
      now = NOW + 14 * day - 1;
      assert.equal(store.tally('subject-hash').denies, 1);
      now = NOW + 14 * day + 1;
      assert.equal(store.tally('subject-hash').denies, 0);
    });

    it('ignores a correction once the decision is too old', () => {
      const day = 86_400_000;
      let now = NOW;
      const store = makeStore(() => now);
      store.noteDecision(decision('d1'));
      store.noteOutcome(outcome('d1', 'decline'));
      now = NOW + 15 * day;
      store.noteOutcome(outcome('d1', 'unsafe', 'user', new Date(now).toISOString()));
      assert.deepEqual(tally(store), ZERO);
    });
  });
});
