import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyPreset,
  decisionModelOptions,
  gatewayModelIds,
  parsePresetModel,
  presetFromAction,
  presetModelOptions,
  presetTarget,
  withCurrent,
} from '../shared/presets.ts';

const presets = {
  fast: { model: 'claude/haiku', modeId: '' },
  standard: { model: '', modeId: '' },
  deep: { model: 'codex/gpt-5.5', modeId: 'full-access' },
};

describe('presets', () => {
  it('parses route actions', () => {
    assert.equal(presetFromAction('route:fast'), 'fast');
    assert.equal(presetFromAction('route:huge'), null);
    assert.equal(presetFromAction('allow'), null);
  });

  it('splits provider/model at the first slash', () => {
    assert.deepEqual(parsePresetModel('openrouter/meta/llama'), {
      provider: 'openrouter',
      model: 'meta/llama',
    });
    assert.equal(parsePresetModel(''), null);
    assert.equal(parsePresetModel('/x'), null);
    assert.equal(parsePresetModel('x/'), null);
  });

  it('maps an action to a target, null when unmapped', () => {
    assert.deepEqual(presetTarget(presets, 'route:deep'), {
      provider: 'codex',
      model: 'gpt-5.5',
      modeId: 'full-access',
    });
    assert.equal(presetTarget(presets, 'route:standard'), null);
    assert.equal(presetTarget(presets, 'log'), null);
  });

  it('changes only the model on the same provider', () => {
    const config = {
      provider: 'claude',
      cwd: '/p',
      model: 'opus',
      modeId: 'plan',
      thinkingOptionId: 'high',
    };
    assert.deepEqual(applyPreset(config, { provider: 'claude', model: 'haiku', modeId: '' }), {
      provider: 'claude',
      cwd: '/p',
      model: 'haiku',
      modeId: 'plan',
      thinkingOptionId: 'high',
    });
  });

  it('drops provider-specific fields when switching provider', () => {
    const config = {
      provider: 'claude',
      cwd: '/p',
      model: 'opus',
      modeId: 'plan',
      thinkingOptionId: 'high',
      providerOptions: { a: 1 },
      featureValues: { b: 2 },
      title: 'T',
    };
    assert.deepEqual(applyPreset(config, { provider: 'codex', model: 'gpt-5.5', modeId: 'auto' }), {
      provider: 'codex',
      cwd: '/p',
      model: 'gpt-5.5',
      modeId: 'auto',
      title: 'T',
    });
  });

  it('builds select options from provider model lists', () => {
    const options = presetModelOptions([
      {
        provider: 'claude',
        models: [
          { id: 'haiku', label: 'Haiku' },
          { id: 'x', label: 'X', isSelectable: false },
        ],
      },
      { provider: 'codex' },
    ]);
    assert.deepEqual(options, [
      { label: 'Not mapped', value: '' },
      { label: 'claude · Haiku', value: 'claude/haiku' },
    ]);
    assert.equal(withCurrent(options, 'gone/model').at(-1)?.value, 'gone/model');
    assert.equal(withCurrent(options, 'claude/haiku').length, 2);
  });

  it('reads gateway model lists of several shapes', () => {
    assert.deepEqual(gatewayModelIds(['a', 'b', 'a']), ['a', 'b']);
    assert.deepEqual(gatewayModelIds({ models: [{ id: 'a' }, { name: 'b' }, 3, null] }), [
      'a',
      'b',
    ]);
    assert.deepEqual(gatewayModelIds(null), []);
    assert.deepEqual(gatewayModelIds({ nope: true }), []);
  });

  it('lists the StrandsAgents models first, then discovered and saved ones', () => {
    const options = decisionModelOptions(['StrandsAgents/new-model'], 'custom/x');
    assert.equal(options[0]?.value, 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610');
    assert.equal(options.length, 7);
    assert.equal(options.at(-1)?.value, 'custom/x');
    assert.equal(options.at(-2)?.label, 'new-model');
  });
});
