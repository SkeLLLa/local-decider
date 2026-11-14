import { parsePolicy, type LogRecord, type ShadowRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { calibrate, calibrateFromFile, formatCalibration } from '../src/calibrate.ts';
import type { LoadedPolicy } from '../src/policies.ts';
import { tempPaths } from './helpers.ts';

const POLICY = parsePolicy(`
id: permission
version: 2
description: permission test
state:
  maxTokens: 1000
  sections:
    - { label: Request, from: request }
questions:
  verdict:
    type: choice
    instructions: Judge.
    criteria: { allow: allow, ask: ask, deny: deny }
rules:
  - when: { question: verdict, answer: allow, minProbability: 0.8 }
    action: allow
default: ask
`);

const LOADED: ReadonlyMap<string, LoadedPolicy> = new Map([
  ['permission', { policy: POLICY, mode: 'shadow', source: '<test>' }],
]);

function decision(
  id: string,
  probability: number,
  group: Partial<Pick<ShadowRecord, 'policy' | 'engine' | 'model'>> = {},
): ShadowRecord {
  return {
    kind: 'decision',
    ts: '2026-11-10T00:00:00.000Z',
    decisionId: id,
    harness: 'cli',
    policy: 'permission',
    mode: 'shadow',
    inputHash: id,
    answers: {
      verdict: {
        type: 'choice',
        answer: 'allow',
        probabilities:
          id === 'd0'
            ? { allow: probability, ask: (1 - probability) / 2, deny: (1 - probability) / 2 }
            : { allow: probability, ask: 1 - probability },
        confidence: 0.5,
      },
    },
    action: 'ask',
    enforced: false,
    engine: 'test-engine',
    model: 'test-model',
    latencyMs: 1,
    ...group,
  };
}

function sampleLog(): LogRecord[] {
  const records: LogRecord[] = [];
  for (let index = 0; index < 100; index += 1) {
    const high = index < 20;
    const middle = index >= 20 && index < 40;
    const id = `d${String(index)}`;
    records.push(decision(id, high ? 0.98 : middle ? 0.9 : 0.55));
    records.push({
      kind: 'outcome',
      ts: '2026-11-10T00:00:01.000Z',
      decisionId: id,
      outcome: high || (middle && index < 36) || (!middle && index < 70) ? 'allow' : 'ask',
      source: 'user',
      verified: true,
    });
  }
  records.push({
    kind: 'outcome',
    ts: '2026-11-10T00:00:02.000Z',
    decisionId: 'd0',
    outcome: 'deny',
    source: 'unverified',
    claimedSource: 'classifier',
    verified: false,
  });
  return records;
}

function thresholdLog(): LogRecord[] {
  const records: LogRecord[] = [];
  for (let index = 0; index < 400; index += 1) {
    const high = index < 200;
    const middle = index >= 200 && index < 300;
    const id = `threshold-${String(index)}`;
    const probability = high ? 0.98 : middle ? 0.9 : 0.55;
    const allowed = high || (index >= 200 && index < 280) || (index >= 300 && index < 350);
    records.push(decision(id, probability));
    records.push({
      kind: 'outcome',
      ts: '2026-11-10T00:00:01.000Z',
      decisionId: id,
      outcome: allowed ? 'allow' : 'ask',
      source: 'user',
      verified: true,
    });
  }
  return records;
}

describe('calibrate', () => {
  it('fits temperature and reports Brier and ECE', () => {
    const [result] = calibrate(sampleLog(), LOADED);
    assert.ok(result);
    assert.equal(result.n, 100);
    assert.equal(result.status, 'calibrated');
    assert.ok(result.temperature !== undefined && result.temperature !== 1);
    assert.ok((result.after?.brier ?? 1) < (result.before?.brier ?? 0));
    assert.ok((result.after?.ece ?? 1) < (result.before?.ece ?? 0));
    assert.equal(result.suggestedAllowThresholds, undefined);
    assert.match(formatCalibration([result]), /T=/);
  });

  it('uses raw probabilities and a Wilson lower bound for threshold suggestions', () => {
    const [result] = calibrate(thresholdLog(), LOADED);
    assert.ok(result);
    assert.ok(result.temperature !== undefined && result.temperature !== 1);
    const suggestion = result.suggestedAllowThresholds?.[0];
    assert.ok(suggestion);
    assert.equal(suggestion.threshold, 0.98);
    assert.equal(suggestion.n, 200);
    assert.equal(suggestion.precision, 1);
  });

  it('does not suggest a threshold from a single perfect top candidate', () => {
    const records = thresholdLog().slice(0, 120);
    let firstDecision = true;
    const singleTopCandidate = records.map((record) => {
      if (record.kind !== 'decision') return record;
      const probability = firstDecision ? 0.99 : 0.8;
      firstDecision = false;
      return decision(record.decisionId, probability);
    });
    const [result] = calibrate(singleTopCandidate, LOADED);
    assert.ok(result);
    assert.equal(result.n, 60);
    assert.equal(result.suggestedAllowThresholds, undefined);
  });

  it('requires the Wilson lower bound rather than empirical precision', () => {
    const records = thresholdLog().slice(0, 200);
    const lastOutcome = records.findLastIndex((record) => record.kind === 'outcome');
    const last = records[lastOutcome];
    assert.ok(last?.kind === 'outcome');
    records[lastOutcome] = { ...last, outcome: 'ask' };
    const [result] = calibrate(records, LOADED);
    assert.ok(result);
    assert.equal(result.n, 100);
    assert.equal(result.suggestedAllowThresholds, undefined);
  });

  it('uses verified ADR-0006 labels and reports insufficient groups', () => {
    const records = sampleLog().filter(
      (record) => record.kind !== 'outcome' || record.decisionId !== 'd0',
    );
    records.push(
      {
        kind: 'outcome',
        ts: 't1',
        decisionId: 'd0',
        outcome: 'decline',
        source: 'user',
        verified: true,
      },
      {
        kind: 'outcome',
        ts: 't2',
        decisionId: 'd0',
        outcome: 'deny',
        source: 'supervised',
        verified: true,
      },
      {
        kind: 'outcome',
        ts: 't3',
        decisionId: 'd1',
        outcome: 'allow',
        source: 'harness',
        verified: false,
      },
      decision('small-1', 0.6, { engine: 'other-engine' }),
      {
        kind: 'outcome',
        ts: 't4',
        decisionId: 'small-1',
        outcome: 'allow',
        source: 'user',
        verified: true,
      },
    );
    const results = calibrate(records, LOADED);
    const primary = results.find((result) => result.engine === 'test-engine');
    const small = results.find((result) => result.engine === 'other-engine');
    assert.equal(primary?.n, 100);
    assert.equal(small?.n, 1);
    assert.equal(small?.status, 'insufficient-data');
    assert.match(formatCalibration(small === undefined ? [] : [small]), /insufficient data/);
  });

  it('does not suggest thresholds without probability-based allow rules', () => {
    const noProbability = parsePolicy(`
id: permission
version: 2
description: confidence-only allow
state:
  maxTokens: 1000
  sections:
    - { label: Request, from: request }
questions:
  verdict:
    type: choice
    instructions: Judge.
    criteria: { allow: allow, ask: ask }
rules:
  - when: { question: verdict, answer: allow, minConfidence: 0.8 }
    action: allow
default: ask
`);
    const policies = new Map([
      ['permission', { policy: noProbability, mode: 'shadow' as const, source: '<test>' }],
    ]);
    const records = sampleLog().filter(
      (record) => record.kind !== 'outcome' || record.outcome !== 'deny',
    );
    const [result] = calibrate(records, policies);
    assert.equal(result?.status, 'calibrated');
    assert.equal(result?.suggestedAllowThresholds, undefined);
  });

  it('reports the no-log message when the database is absent', () => {
    const results = calibrateFromFile(tempPaths(), LOADED);
    assert.deepEqual(results, []);
    assert.equal(formatCalibration(results), 'No verified calibration data logged yet.');
  });
});
