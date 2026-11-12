import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ALLOW_THRESHOLD_FLOOR,
  evaluateRules,
  parsePolicy,
  PolicyError,
  policyRoutes,
  policySections,
  policyThresholds,
  withThresholds,
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

  it('requires a high threshold for allow rules and forbids allow defaults', () => {
    const bare = MINIMAL.replace('answer: a, minConfidence: 0.9', 'answer: a');
    assert.throws(
      () => parsePolicy(bare),
      /allow rules need minConfidence or minProbability at least 0.8/,
    );
    const low = MINIMAL.replace('minConfidence: 0.9', 'minProbability: 0.7');
    assert.throws(() => parsePolicy(low), /at least 0.8/);
    assert.doesNotThrow(() =>
      parsePolicy(MINIMAL.replace('minConfidence: 0.9', 'minProbability: 0.8')),
    );
    assert.throws(
      () => parsePolicy(MINIMAL.replace('default: ask', 'default: allow')),
      /default cannot be allow/,
    );
  });

  it('allows lower precedent thresholds only on allow or ask rules', () => {
    const precedent = MINIMAL.replace(
      'description: demo',
      'description: demo\nprecedent: { from: subject }',
    ).replace('answer: a, minConfidence: 0.9', 'answer: a, minProbability: 0.6, precedent: allow');
    assert.doesNotThrow(() => parsePolicy(precedent));
    assert.throws(
      () => parsePolicy(precedent.replace('action: allow', 'action: deny')),
      /precedent rules may only use allow or ask/,
    );
  });
});

describe('variants and routes', () => {
  it('accepts variantOf but not a policy naming itself', () => {
    assert.equal(parsePolicy(`${MINIMAL}variantOf: other\n`).variantOf, 'other');
    assert.throws(() => parsePolicy(`${MINIMAL}variantOf: demo\n`), /its own variant/);
  });

  it('lists route presets from rules and the default, once each', () => {
    assert.deepEqual(policyRoutes(parsePolicy(MINIMAL)), ['big']);
    const routed = MINIMAL.replace('action: allow', 'action: route:small').replace(
      'default: ask',
      'default: route:big',
    );
    assert.deepEqual(policyRoutes(parsePolicy(routed)), ['small', 'big']);
  });

  it('ships routing variants that name their base policy', () => {
    for (const file of ['routing-budget.yaml', 'routing-task-kind.yaml']) {
      const policy = parsePolicy(readFileSync(join(POLICY_DIR, file), 'utf8'), file);
      assert.equal(policy.variantOf, 'routing');
      assert.ok(policyRoutes(policy).length >= 3);
    }
  });
});

const allowAt = (p: number): Record<string, Answer> => ({
  verdict: choice('allow', { allow: p, ask: 1 - p, deny: 0 }, 0.5),
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

  it('uses precedent only when the model still leans allow', () => {
    const permission = parsePolicy(readFileSync(join(POLICY_DIR, 'permission.yaml'), 'utf8'));
    assert.equal(evaluateRules(permission, allowAt(0.7)).action, 'ask');
    assert.equal(
      evaluateRules(permission, allowAt(0.7), { precedentAllows: true }).action,
      'allow',
    );
    assert.equal(evaluateRules(permission, allowAt(0.59), { precedentAllows: true }).action, 'ask');
    assert.deepEqual(permission.precedent, {
      from: 'subject',
      minAllows: 3,
      maxAgeDays: 14,
      sources: ['user', 'supervised'],
    });
  });
});

describe('thresholds', () => {
  const policy: Policy = parsePolicy(MINIMAL);

  it('lists each rule threshold with its default and effective value', () => {
    assert.deepEqual(policyThresholds(policy, { 'pick.b': 0.8 }), [
      {
        key: 'pick.a',
        question: 'pick',
        answer: 'a',
        action: 'allow',
        kind: 'minConfidence',
        default: 0.9,
        value: 0.9,
        floor: 0.8,
      },
      {
        key: 'pick.b',
        question: 'pick',
        answer: 'b',
        action: 'route:big',
        kind: 'minProbability',
        default: 0.6,
        value: 0.8,
        floor: 0,
      },
    ]);
  });

  it('replaces the bound the rule has, minConfidence when it has none', () => {
    const tuned = withThresholds(policy, { 'pick.a': 0.5, 'pick.b': 0.9, 'nope.x': 1 });
    assert.deepEqual(tuned.rules[0]?.when, { question: 'pick', answer: 'a', minConfidence: 0.8 });
    assert.deepEqual(tuned.rules[1]?.when, { question: 'pick', answer: 'b', minProbability: 0.9 });
    assert.equal(policy.rules[0]?.when.minConfidence, 0.9, 'the loaded policy is untouched');
    assert.equal(withThresholds(policy, {}), policy);
    const bare = { ...policy, rules: [{ when: { question: 'pick', answer: 'a' }, action: 'log' }] };
    assert.equal(policyThresholds(bare)[0]?.default, null);
    assert.equal(withThresholds(bare, { 'pick.a': 0.3 }).rules[0]?.when.minConfidence, 0.3);
  });

  it('never takes an allow rule below the floor', () => {
    const tuned = withThresholds(policy, { 'pick.a': 0.1, 'pick.b': 0.1 });
    assert.equal(tuned.rules[0]?.when.minConfidence, ALLOW_THRESHOLD_FLOOR);
    assert.equal(tuned.rules[1]?.when.minProbability, 0.1, 'route rules have no floor');
    assert.equal(policyThresholds(policy, { 'pick.a': 0.1 })[0]?.value, ALLOW_THRESHOLD_FLOOR);
  });

  it('does not apply user threshold overrides to precedent rules', () => {
    const permission = parsePolicy(readFileSync(join(POLICY_DIR, 'permission.yaml'), 'utf8'));
    const tuned = withThresholds(permission, { 'verdict.allow': 0.9 });
    assert.equal(tuned.rules[0]?.when.minProbability, 0.6);
    assert.equal(tuned.rules[1]?.when.minProbability, 0.9);
    assert.equal(
      policyThresholds(permission).find((threshold) => threshold.key === 'verdict.allow')?.default,
      0.95,
    );
  });

  it('changes what the rules decide', () => {
    const answers = { pick: choice('a', { a: 0.9, b: 0.1 }, 0.8) };
    assert.equal(evaluateRules(policy, answers).action, 'ask');
    assert.equal(
      evaluateRules(withThresholds(policy, { 'pick.a': 0.75 }), answers).action,
      'allow',
    );
  });
});

describe('policySections', () => {
  it('renders input keys in policy order with their keep side', () => {
    const policy = parsePolicy(MINIMAL);
    const sections = policySections(policy, { text: 42 }, (v) => String(v));
    assert.deepEqual(sections, [{ label: 'In', keep: 'tail', text: '42' }]);
  });
});
