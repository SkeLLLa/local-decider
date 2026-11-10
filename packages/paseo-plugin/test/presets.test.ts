import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyPreset,
  parsePresetModel,
  presetFromAction,
  presetModelOptions,
  presetTarget,
  routeTarget,
  withCurrent,
} from '../shared/presets.ts';

const presets = {
  fast: { model: 'claude/haiku', modeId: '' },
  standard: { model: '', modeId: '' },
  deep: { model: 'codex/gpt-5.5', modeId: 'full-access' },
  cheap: { model: 'claude/haiku', modeId: '' },
};

describe('presets', () => {
  it('parses route actions', () => {
    assert.equal(presetFromAction('route:fast'), 'fast');
    assert.equal(presetFromAction('route:my-tier'), 'my-tier');
    assert.equal(presetFromAction('route:'), null);
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
    assert.equal(presetTarget(presets, 'route:cheap')?.model, 'haiku', 'user-defined preset');
    assert.equal(presetTarget(presets, 'route:huge'), null, 'unknown preset');
    assert.equal(presetTarget(presets, 'route:constructor'), null, 'no prototype keys');
    assert.equal(presetTarget(presets, 'log'), null);
  });

  it('turns the gateway route into a target, ignoring malformed ones', () => {
    assert.deepEqual(routeTarget({ model: 'codex/gpt-5.5', mode: 'auto' }), {
      provider: 'codex',
      model: 'gpt-5.5',
      modeId: 'auto',
    });
    assert.equal(routeTarget({ model: 'haiku' }), null, 'not provider/model');
    assert.equal(routeTarget({ model: 42 }), null);
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
});
