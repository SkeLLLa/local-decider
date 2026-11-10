import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { authoringPrompt } from '../src/authoring.ts';
import { defaultPolicyDir, loadPolicies } from '../src/policies.ts';
import { tempPaths, testConfig } from './helpers.ts';

describe('authoringPrompt', () => {
  const policies = loadPolicies(testConfig(), [defaultPolicyDir()]);

  it('fills the routing prompt with the user dir, input keys and every variant', () => {
    const paths = tempPaths();
    const prompt = authoringPrompt('routing', policies, paths);
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
    assert.ok(prompt.includes(join(paths.config, 'policies')));
    assert.ok(prompt.includes('`project`, `prompt`'));
    assert.ok(prompt.includes('variantOf: routing'));
    assert.ok(prompt.indexOf('id: routing\n') < prompt.indexOf('id: routing-budget'));
    assert.ok(prompt.includes('id: routing-task-kind'));
  });

  it('refuses policies without a prompt and variants', () => {
    assert.throws(() => authoringPrompt('permission', policies, tempPaths()), /no authoring/);
    assert.throws(() => authoringPrompt('routing-budget', policies, tempPaths()), /no authoring/);
  });
});
