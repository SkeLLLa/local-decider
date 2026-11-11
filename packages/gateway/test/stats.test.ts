import {
  parsePolicy,
  type LogRecord,
  type ShadowRecord,
  type UsageRecord,
} from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ClassifierAgreement } from '../src/classifier-agreement.ts';
import type { LoadedPolicy } from '../src/policies.ts';
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

  it('counts supervised outcomes as labelled decisions', () => {
    const [stats] = computeStats([
      decision('child-decision', 'allow', 0.9),
      {
        kind: 'outcome',
        ts: '2026-11-10T00:00:01.000Z',
        decisionId: 'child-decision',
        outcome: 'allow',
        source: 'supervised',
      },
    ]);
    assert.equal(stats?.labelled, 1);
    assert.equal(stats?.agreement, 1);
  });

  it('reports an empty log', () => {
    assert.equal(formatStats(computeStats([])), 'No decisions logged yet.');
  });
});

function escalations(total: number, denied: number, lowBand = 0): LogRecord[] {
  const records: LogRecord[] = [];
  for (let i = 0; i < total; i += 1) {
    const id = `escalation-${String(i)}`;
    const probability = i < lowBand ? 0.8 : 0.9;
    records.push(decision(id, 'allow', probability, { action: 'ask' }));
    records.push({
      kind: 'outcome',
      ts: '2026-11-10T00:00:01.000Z',
      decisionId: id,
      outcome: i < denied ? 'deny' : 'allow',
      source: 'user',
      verified: true,
    });
  }
  return records;
}

describe('calibration hints', () => {
  const permissionPolicy = parsePolicy(
    readFileSync(new URL('../../../policies/permission.yaml', import.meta.url), 'utf8'),
  );
  const policies = new Map<string, LoadedPolicy>([
    ['permission', { policy: permissionPolicy, mode: 'act', source: 'permission.yaml' }],
  ]);

  it('suggests the lowest threshold meeting the Wilson deny bound', () => {
    const records = escalations(300, 100, 100);
    const [stats] = computeStats(records, {}, policies);
    assert.deepEqual(stats?.calibrationHints, [
      { rule: 'verdict.allow', threshold: 0.9, n: 200, denies: 0 },
    ]);
    assert.match(formatStats([stats]), /suggest t=0\.90 \(n=200, denies=0\)/);
    assert.match(formatStats([stats]), /advisory; not applied/);
  });

  it('reports the sample count when no threshold has a low enough deny bound', () => {
    const [stats] = computeStats(escalations(120, 3), {}, policies);
    assert.deepEqual(stats?.calibrationHints, [{ rule: 'verdict.allow', n: 120, denies: 3 }]);
    assert.match(formatStats([stats]), /not enough labelled escalations \(n=120, denies=3\)/);
  });

  it('excludes unverified outcomes from calibration samples', () => {
    const records = escalations(1, 0);
    const outcome = records[1];
    assert.ok(outcome?.kind === 'outcome');
    records[1] = { ...outcome, verified: false };
    const [stats] = computeStats(records, {}, policies);
    assert.deepEqual(stats?.calibrationHints, [{ rule: 'verdict.allow', n: 0, denies: 0 }]);
    assert.equal(stats?.labelled, 1, 'agreement and reliability still use every outcome');
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

  it('reads only the date window requested for precedent rebuilds', () => {
    const { logs } = tempPaths();
    const log = new ShadowLog(logs);
    log.append({ ...decision('old', 'ask', 0.8), ts: '2026-10-01T00:00:00.000Z' });
    log.append({ ...decision('recent', 'ask', 0.8), ts: '2026-11-09T00:00:00.000Z' });
    assert.deepEqual(
      log.readRecent(2, Date.parse('2026-11-10T00:00:00.000Z')).map((record) => record.decisionId),
      ['recent'],
    );
  });
});

const verdict = (id: string, outcome: string, source = 'classifier'): LogRecord => ({
  kind: 'outcome',
  ts: 't',
  decisionId: id,
  outcome,
  source: source as 'classifier',
});

const agreement = (input: LogRecord[]): ClassifierAgreement => {
  const found = computeStats(input, {}, undefined, { scope: 'claude-auto' })[0]
    ?.classifierAgreement;
  assert.ok(found, 'classifier agreement present');
  return found;
};

describe('classifier agreement', () => {
  const scoped = (id: string, action: string, extra: Partial<ShadowRecord> = {}): ShadowRecord =>
    decision(id, action === 'allow' ? 'allow' : 'ask', 0.9, {
      scope: 'claude-auto',
      action,
      ...extra,
    });
  const records: LogRecord[] = [
    scoped('a1', 'allow'),
    scoped('a2', 'allow'),
    scoped('a3', 'allow'),
    scoped('d1', 'allow'),
    scoped('k1', 'ask'),
    scoped('k2', 'ask'),
    scoped('auto', 'allow', { enforced: true }),
    scoped('slow', 'ask', { error: 'decision timed out', latencyMs: 1500 }),
    scoped('nolabel', 'allow'),
    decision('other', 'allow', 0.9),
    verdict('a1', 'allow'),
    verdict('a2', 'allow'),
    verdict('a3', 'allow'),
    verdict('d1', 'deny'),
    verdict('k1', 'allow'),
    verdict('k2', 'deny'),
    verdict('auto', 'allow'),
    verdict('nolabel', 'allow', 'user'),
  ];

  it('counts compared decisions, coverage and allow precision', () => {
    const a = agreement(records);
    assert.equal(a.decisions, 9, 'unscoped decisions are filtered out');
    assert.equal(a.n, 6, 'auto-allowed, unlabelled and user-labelled ones are not compared');
    assert.equal(a.coverage, 6 / 9);
    assert.equal(a.wouldAllow, 4);
    assert.equal(a.bothAllowed, 3);
    assert.equal(a.allowPrecision, 0.75);
    assert.ok(a.allowPrecisionLower !== undefined && a.allowPrecisionLower < 0.75);
    assert.ok(a.allowPrecisionLower !== undefined && a.allowPrecisionLower > 0.2);
  });

  it('reports the ask-rate on classifier-allowed calls, disagreements, latency and errors', () => {
    const a = agreement(records);
    assert.equal(a.classifierAllowed, 4);
    assert.equal(a.askRateOnClassifierAllowed, 0.25);
    assert.deepEqual(a.disagreements, ['d1']);
    assert.equal(a.errors, 1);
    assert.equal(a.latencyP50Ms, 100);
  });

  it('filters the policy decisions to the scope', () => {
    const [s] = computeStats(records, {}, undefined, { scope: 'claude-auto' });
    assert.equal(s?.decisions, 9);
  });

  it('caps the disagreement list at 20 ids', () => {
    const many: LogRecord[] = [];
    for (let i = 0; i < 25; i += 1) {
      many.push(scoped(`x${String(i)}`, 'allow'), verdict(`x${String(i)}`, 'deny'));
    }
    const a = agreement(many);
    assert.equal(a.disagreements.length, 20);
    assert.equal(a.disagreements[0], 'x0');
    assert.equal(a.allowPrecision, 0);
  });

  it('attaches the section without a filter and omits it when nothing is scoped', () => {
    const all = computeStats(records);
    assert.equal(all[0]?.decisions, 10);
    assert.equal(all[0]?.classifierAgreement?.n, 6);
    assert.equal(computeStats([decision('z', 'allow', 0.9)])[0]?.classifierAgreement, undefined);
    assert.deepEqual(
      computeStats([decision('z', 'allow', 0.9)], {}, undefined, { scope: 'claude-auto' }),
      [],
    );
  });

  it('formats the section for the CLI', () => {
    const text = formatStats(computeStats(records, {}, undefined, { scope: 'claude-auto' }));
    assert.match(text, /classifier agreement \(claude-auto\): 9 decisions, 6 compared/);
    assert.match(text, /allow precision 75\.0%, Wilson 95% lower/);
    assert.match(text, /disagreements \(decider allow, classifier deny\): d1/);
  });
});
