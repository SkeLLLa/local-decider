import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  evaluateRules,
  parsePolicy,
  PolicyError,
  policySections,
  type Answer,
  type Policy,
} from '../src/index.ts';

const POLICY_DIR = join(import.meta.dirname, '..', '..', '..', 'policies');

const MINIMAL = `
id: demo
version: 1
description: demo
state: { sections: [{ label: In, from: text }] }
questions:
  pick: { type: choice, instructions: Pick one., criteria: { a: A., b: B. } }
rules:
  - when: { question: pick, answer: a, minConfidence: 0.9 }
    action: allow
  - when: { question: pick, answer: b, minProbability: 0.6 }
    action: route:big
default: ask
`;

function choice(answer: string, probabilities: Record<string, number>, confidence: number): Answer {
  return { type: 'choice', answer, probabilities, confidence };
}

describe('parsePolicy', () => {
  it('loads every shipped default policy', () => {
    const files = readdirSync(POLICY_DIR).filter((f) => f.endsWith('.yaml'));
    assert.ok(files.length >= 4);
    for (const file of files) {
      const policy = parsePolicy(readFileSync(join(POLICY_DIR, file), 'utf8'), file);
      assert.equal(`${policy.id}.yaml`, file);
      assert.equal(policy.mode, 'shadow', `${file} ships in shadow mode`);
    }
  });

  it('applies defaults', () => {
    const policy = parsePolicy(MINIMAL);
    assert.equal(policy.mode, 'shadow');
    assert.equal(policy.state.maxTokens, 3000);
    assert.equal(policy.state.sections[0]?.keep, 'tail');
    assert.deepEqual(policy.cache, { ttlSeconds: 0 });
  });

  it('rejects rules naming unknown questions or answers', () => {
    const bad = MINIMAL.replace('answer: a,', 'answer: c,').replace(
      'question: pick, answer: b',
      'question: nope, answer: b',
    );
    assert.throws(
      () => parsePolicy(bad, 'bad.yaml'),
      (error: unknown) => {
        assert.ok(error instanceof PolicyError);
        assert.match(error.message, /bad\.yaml: invalid policy/);
        assert.match(error.message, /"c" is not one of a, b/);
        assert.match(error.message, /unknown question "nope"/);
        return true;
      },
    );
  });

  it('rejects unknown keys, bad actions and invalid YAML', () => {
    assert.throws(() => parsePolicy(`${MINIMAL}\nextra: 1\n`), PolicyError);
    assert.throws(
      () => parsePolicy(MINIMAL.replace('action: allow', 'action: rm -rf')),
      PolicyError,
    );
    assert.throws(() => parsePolicy('id: [unclosed'), /invalid YAML/);
    assert.throws(() => parsePolicy('a: 1\na: 2\n'), /invalid YAML/);
  });

  it('rejects single-option choices and one-level scores', () => {
    assert.throws(() => parsePolicy(MINIMAL.replace('{ a: A., b: B. }', '{ a: A. }')), /2\.\.255/);
    const score = MINIMAL.replace(
      '{ type: choice, instructions: Pick one., criteria: { a: A., b: B. } }',
      '{ type: score, instructions: Rate., criteria: [Low] }',
    );
    assert.throws(() => parsePolicy(score), PolicyError);
  });
});

describe('evaluateRules', () => {
  const policy: Policy = parsePolicy(MINIMAL);

  it('maps an answer above its threshold to the rule action', () => {
    const match = evaluateRules(policy, { pick: choice('a', { a: 0.97, b: 0.03 }, 0.94) });
    assert.deepEqual(match, { action: 'allow', rule: 0 });
  });

  it('falls back to the default below the threshold', () => {
    const match = evaluateRules(policy, { pick: choice('a', { a: 0.9, b: 0.1 }, 0.8) });
    assert.deepEqual(match, { action: 'ask', rule: -1 });
  });

  it('honours minProbability', () => {
    assert.equal(
      evaluateRules(policy, { pick: choice('b', { a: 0.35, b: 0.65 }, 0.3) }).action,
      'route:big',
    );
    assert.equal(
      evaluateRules(policy, { pick: choice('b', { a: 0.45, b: 0.55 }, 0.1) }).action,
      'ask',
    );
  });

  it('falls back to the default when the engine gave no answer', () => {
    assert.deepEqual(evaluateRules(policy, {}), { action: 'ask', rule: -1 });
  });

  it('auto-allows permission only at p(allow) >= 0.95', () => {
    const permission = parsePolicy(readFileSync(join(POLICY_DIR, 'permission.yaml'), 'utf8'));
    const at = (p: number): string =>
      evaluateRules(permission, {
        verdict: choice('allow', { allow: p, ask: 1 - p, deny: 0 }, 0.9),
      }).action;
    assert.equal(at(0.96), 'allow');
    assert.equal(at(0.94), 'ask');
  });
});

describe('policySections', () => {
  it('renders input keys in policy order with their keep side', () => {
    const policy = parsePolicy(MINIMAL);
    const sections = policySections(policy, { text: 42 }, (v) => String(v));
    assert.deepEqual(sections, [{ label: 'In', keep: 'tail', text: '42' }]);
  });
});
