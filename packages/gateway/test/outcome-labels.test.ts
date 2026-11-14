import type { LogRecord, OutcomeSource, Policy } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALLOW_VETO_REPLAY_MS,
  comparableOutcome,
  correctedOutcome,
  isVerifiedOutcome,
  outcomeClass,
} from '../src/outcome-labels.ts';
import { PrecedentStore } from '../src/precedent.ts';
import { tempLog } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const HOUR = 3_600_000;
const SETTINGS = {
  from: 'subject',
  minAllows: 3,
  maxAgeDays: 14,
  sources: ['user'],
  vetoSources: [],
} satisfies NonNullable<Policy['precedent']>;

function store(): PrecedentStore {
  return new PrecedentStore(
    (id) => (id === 'permission' ? SETTINGS : undefined),
    () => NOW,
  );
}

function decision(id: string, key: string, action: string, agoMs: number): LogRecord {
  return makeShadowRecord(id, {
    precedentKey: key,
    action,
    ts: new Date(NOW - agoMs).toISOString(),
  });
}

function outcome(id: string, value: string, agoMs = 0, source: OutcomeSource = 'user'): LogRecord {
  return {
    kind: 'outcome',
    ts: new Date(NOW - agoMs).toISOString(),
    decisionId: id,
    outcome: value,
    source,
    verified: true,
  };
}

describe('outcome labels', () => {
  it('classifies outcomes', () => {
    assert.equal(outcomeClass('allow'), 'allow');
    assert.equal(outcomeClass('deny'), 'veto');
    assert.equal(outcomeClass('unsafe'), 'veto');
    assert.equal(outcomeClass('decline'), 'neutral');
    assert.equal(outcomeClass('interrupted'), 'neutral');
    assert.equal(outcomeClass('done'), 'other');
  });

  it('corrects a neutral outcome to a veto only', () => {
    assert.equal(correctedOutcome(undefined, 'done'), 'done');
    assert.equal(correctedOutcome('decline', 'unsafe'), 'unsafe');
    assert.equal(correctedOutcome('decline', 'deny'), 'deny');
    assert.equal(correctedOutcome('interrupted', 'unsafe'), 'unsafe');
    for (const [current, next] of [
      ['decline', 'allow'],
      ['allow', 'unsafe'],
      ['unsafe', 'deny'],
      ['deny', 'decline'],
      ['decline', 'interrupted'],
    ] as const) {
      assert.equal(correctedOutcome(current, next), undefined, `${current} -> ${next}`);
    }
  });

  it('maps outcomes for agreement statistics', () => {
    assert.equal(comparableOutcome('unsafe'), 'deny');
    assert.equal(comparableOutcome('decline'), undefined);
    assert.equal(comparableOutcome('done'), 'done');
  });

  it('accepts only verified outcomes from a real source', () => {
    assert.equal(isVerifiedOutcome({ source: 'user', verified: true }), true);
    assert.equal(isVerifiedOutcome({ source: 'user', verified: false }), false);
    assert.equal(isVerifiedOutcome({ source: 'user' }), false);
    assert.equal(isVerifiedOutcome({ source: 'unverified', verified: true }), false);
  });

  it('replays auto-allows for at least the plugin label window (24 h)', () => {
    // Mirrors LABEL_WINDOW_MS in packages/paseo-plugin/shared/row.ts.
    assert.ok(ALLOW_VETO_REPLAY_MS >= 24 * HOUR);
  });
});

function replay(log: ReturnType<typeof tempLog>): PrecedentStore {
  const rebuilt = store();
  rebuilt.rebuild(log.readVerifiedPrecedent(14, NOW));
  return rebuilt;
}

describe('keyed auto-allows only react to eligible vetoes', () => {
  const noise: LogRecord[] = [
    outcome('aa', 'allow'),
    outcome('aa', 'unsafe', 0, 'classifier'),
    outcome('aa', 'decline'),
  ];

  it('still vetoes after an allow, an ineligible veto and a decline (live)', () => {
    const live = store();
    live.noteDecision(decision('aa', 'KA', 'allow', HOUR) as never);
    for (const record of noise) {
      live.noteOutcome(record as never);
    }
    live.noteOutcome(outcome('aa', 'unsafe') as never);
    assert.deepEqual(live.tally('KA'), { allows: 0, denies: 1 });
  });

  it('behaves the same after a SQLite rebuild', () => {
    const log = tempLog();
    try {
      log.append(decision('aa', 'KA', 'allow', HOUR));
      for (const record of noise) {
        log.append(record);
      }
      const rebuilt = replay(log);
      assert.deepEqual(rebuilt.tally('KA'), { allows: 0, denies: 0 });
      rebuilt.noteOutcome(outcome('aa', 'unsafe') as never);
      assert.deepEqual(rebuilt.tally('KA'), { allows: 0, denies: 1 });
    } finally {
      log.close();
    }
  });
});

describe('SQLite to PrecedentStore round trips', () => {
  it('replays a decline corrected to unsafe, and an old vetoed auto-allow', () => {
    const log = tempLog();
    try {
      log.append(decision('ask', 'K', 'ask', 2 * HOUR));
      log.append(outcome('ask', 'decline', HOUR));
      log.append(outcome('ask', 'unsafe', 0));
      log.append(decision('old', 'K2', 'allow', 72 * HOUR));
      log.append(outcome('old', 'unsafe', 70 * HOUR));
      const rebuilt = replay(log);
      assert.deepEqual(rebuilt.tally('K'), { allows: 0, denies: 1 });
      assert.deepEqual(rebuilt.tally('K2'), { allows: 0, denies: 1 });
    } finally {
      log.close();
    }
  });

  it('lets a first veto land after a restart', () => {
    const log = tempLog();
    try {
      log.append(decision('k3', 'K3', 'allow', HOUR));
      const rebuilt = replay(log);
      rebuilt.noteOutcome(outcome('k3', 'unsafe') as never);
      assert.equal(rebuilt.tally('K3').denies, 1);
    } finally {
      log.close();
    }
  });

  it('does not replay a keyed auto-allow older than the window without a veto', () => {
    const log = tempLog();
    try {
      log.append(decision('stale', 'K4', 'allow', 26 * HOUR));
      const rebuilt = replay(log);
      rebuilt.noteOutcome(outcome('stale', 'unsafe') as never);
      assert.deepEqual(rebuilt.tally('K4'), { allows: 0, denies: 0 });
    } finally {
      log.close();
    }
  });

  it('matches live tallies after a rebuild', () => {
    const records: LogRecord[] = [
      decision('a', 'K', 'ask', 5 * HOUR),
      decision('b', 'K', 'ask', 5 * HOUR),
      decision('c', 'K', 'ask', 5 * HOUR),
      outcome('a', 'allow', 4 * HOUR),
      outcome('b', 'allow', 4 * HOUR),
      outcome('c', 'allow', 4 * HOUR),
      decision('d', 'K', 'ask', 3 * HOUR),
      outcome('d', 'decline', 2 * HOUR),
      outcome('d', 'unsafe', HOUR),
      decision('e', 'K', 'allow', 4 * HOUR),
      outcome('e', 'unsafe', 3 * HOUR),
    ];
    const live = store();
    for (const record of records) {
      if (record.kind === 'decision') {
        live.noteDecision(record);
      } else if (record.kind === 'outcome') {
        live.noteOutcome(record);
      }
    }
    const log = tempLog();
    try {
      for (const record of records) {
        log.append(record);
      }
      assert.deepEqual(replay(log).tally('K'), live.tally('K'));
      assert.deepEqual(live.tally('K'), { allows: 3, denies: 2 });
    } finally {
      log.close();
    }
  });
});
