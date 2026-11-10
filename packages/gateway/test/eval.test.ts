import type { DecideResponse } from '@local-decider/core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseEvalCases, runPolicyEval } from '../src/eval.ts';

const result: DecideResponse = {
  decisionId: 'd-1',
  policy: 'permission',
  mode: 'shadow',
  action: 'allow',
  enforced: false,
  answers: {
    verdict: {
      type: 'choice',
      answer: 'allow',
      probabilities: { allow: 0.7, ask: 0.2, deny: 0.1 },
      confidence: 0.5,
    },
  },
  rule: 0,
  engine: 'test',
  model: 'test',
  latencyMs: 1,
  cached: false,
};

describe('policy eval', () => {
  it('loads the synthetic permission fixture cases', () => {
    const source = readFileSync(
      new URL('../../../policies/fixtures/permission.jsonl', import.meta.url),
      'utf8',
    );
    const cases = parseEvalCases(source, 'permission.jsonl');
    const expected = cases.map((testCase) => testCase.expect);
    assert.deepEqual(expected.slice(0, 10), [
      'allow',
      'allow',
      'allow',
      'allow',
      'ask',
      'ask',
      'ask',
      'ask',
      'deny',
      'ask',
    ]);
    // The claude-auto injection fixtures: text that talks the reviewer into allowing must never
    // be expected to produce an allow.
    const injection = expected.slice(10);
    assert.equal(injection.length, 10);
    assert.ok(injection.every((answer) => answer === 'ask' || answer === 'deny'));
  });

  it('parses JSONL cases and reports malformed records with line numbers', () => {
    assert.deepEqual(parseEvalCases('{"input":{"command":"ls"},"expect":"allow"}\n'), [
      { input: { command: 'ls' }, expect: 'allow' },
    ]);
    assert.throws(() => parseEvalCases('{}', 'fixtures.jsonl'), /fixtures.jsonl:1/);
    assert.throws(
      () => parseEvalCases('{bad}', 'fixtures.jsonl'),
      /fixtures.jsonl:1: invalid JSON/,
    );
  });

  it('reports expected action and selected answer probability without failing mismatches', async () => {
    const reports: string[] = [];
    const calls: { policy: string; harness: string }[] = [];
    await runPolicyEval(
      'permission',
      [
        { input: { command: 'git status' }, expect: 'deny' },
        { input: {}, expect: 'ask' },
      ],
      async (policy, request) => {
        calls.push({ policy, harness: request.harness });
        if (calls.length === 2) {
          throw new Error('gateway unavailable');
        }
        return result;
      },
      (line) => reports.push(line),
    );

    assert.deepEqual(calls, [
      { policy: 'permission', harness: 'cli' },
      { policy: 'permission', harness: 'cli' },
    ]);
    assert.deepEqual(reports, [
      '1 expected=deny action=allow p=0.700',
      '2 expected=ask action=unavailable p=-',
    ]);
  });
});
