import { ALLOW_THRESHOLD_FLOOR } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  listPolicyThresholds,
  listPolicyVariants,
  policyPrompt,
  reloadPolicies,
  routingSettings,
  setPolicyThresholds,
  setPolicyVariant,
  setRoutingPreset,
} from '../server/engines.ts';
import { ALLOW_THRESHOLD } from '../shared/constants.ts';
import {
  allowWarning,
  legacyPresetMoves,
  parsePolicyThresholds,
  parsePolicyVariants,
  parseRoutingSettings,
  presetRows,
  clampThreshold,
  parseThresholdInput,
  thresholdFloor,
  warningZones,
  thresholdLabel,
  thresholdText,
  type ThresholdSetting,
} from '../shared/policies.ts';
import { settingsSchema } from '../shared/settings-schema.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

describe('parsePolicyVariants', () => {
  it('returns the active variant and each variant with its routes', async () => {
    const body = await fakeGateway(() => null).policies();
    assert.deepEqual(parsePolicyVariants(body, 'routing'), {
      ok: true,
      error: null,
      active: 'routing-budget',
      variants: [
        { id: 'routing', description: 'Tiers.', routes: ['fast', 'deep'] },
        { id: 'routing-budget', description: 'Cheap first.', routes: ['cheap'] },
      ],
    });
  });

  it('treats an older gateway without variants as the policy alone', () => {
    const body = [{ id: 'routing', description: 'Tiers.', routes: ['fast'] }];
    const parsed = parsePolicyVariants(body, 'routing');
    assert.equal(parsed.active, 'routing');
    assert.deepEqual(
      parsed.variants.map((v) => v.id),
      ['routing'],
    );
  });

  it('reports a missing policy or list', () => {
    assert.equal(parsePolicyVariants(null, 'routing').ok, false);
    assert.match(
      parsePolicyVariants([{ id: 'permission' }], 'routing').error ?? '',
      /No "routing"/,
    );
  });
});

describe('presetRows', () => {
  it('lists the routes, then mapped presets the policy does not use', () => {
    const saved = {
      fast: { model: 'claude/haiku' },
      cheap: { model: 'claude/haiku' },
      deep: { model: '' },
      stale: { model: '' },
    };
    assert.deepEqual(presetRows(['deep', 'fast'], saved), [
      { name: 'deep', used: true },
      { name: 'fast', used: true },
      { name: 'cheap', used: false },
    ]);
  });
});

describe('settings presets', () => {
  it('keeps v3 fast/standard/deep settings and accepts any preset name', () => {
    const presets = { fast: { model: 'a/b' }, cheap: { model: 'c/d', modeId: 'auto' } };
    assert.deepEqual(settingsSchema.parse({ presets }).presets, {
      fast: { model: 'a/b', modeId: '' },
      cheap: { model: 'c/d', modeId: 'auto' },
    });
    assert.deepEqual(settingsSchema.parse({}).presets, {});
  });

  it('rejects names a policy action could not carry', () => {
    assert.equal(settingsSchema.safeParse({ presets: { 'Bad Name': {} } }).success, false);
  });
});

describe('policy RPC handlers', () => {
  it('lists variants, chooses one and reloads through the gateway', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    assert.equal((await listPolicyVariants(d, 'routing')).active, 'routing-budget');
    assert.deepEqual(await setPolicyVariant(d, { policy: 'routing', variant: 'routing' }), {
      ok: true,
      error: null,
    });
    assert.deepEqual(await reloadPolicies(d), { ok: true, error: null, count: 3 });
    assert.deepEqual(gw.posts, [
      { name: 'setPolicyVariant', input: { policy: 'routing', variant: 'routing' } },
      { name: 'reloadPolicies', input: {} },
    ]);
  });

  it('fails cleanly without a gateway or when it refuses', async () => {
    assert.equal((await listPolicyVariants(deps(settings(), null), 'routing')).ok, false);
    const gw = {
      ...fakeGateway(() => null),
      reloadPolicies: async () => ({ ok: false as const, error: 'bad.yaml: invalid YAML' }),
    };
    assert.deepEqual(await reloadPolicies(deps(settings(), gw)), {
      ok: false,
      error: 'bad.yaml: invalid YAML',
      count: 0,
    });
  });
});

describe('rule thresholds', () => {
  const allow: ThresholdSetting = {
    key: 'verdict.allow',
    question: 'verdict',
    answer: 'allow',
    action: 'allow',
    kind: 'minProbability',
    default: 0.95,
    value: 0.95,
    floor: 0.8,
  };

  it('lists the thresholds of the variant answering, and sets them through the gateway', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    const permission = await listPolicyThresholds(d, 'permission');
    assert.equal(permission.policy, 'permission');
    assert.equal(permission.thresholds[0]?.value, 0.9);
    const routing = await listPolicyThresholds(d, 'routing');
    assert.deepEqual([routing.policy, routing.thresholds], ['routing-budget', []]);
    assert.equal((await listPolicyThresholds(deps(settings(), null), 'routing')).ok, false);
    assert.equal(parsePolicyThresholds([], 'permission').ok, false);
    const input = { policy: 'permission', thresholds: { 'verdict.allow': null } };
    assert.deepEqual(await setPolicyThresholds(d, input), { ok: true, error: null });
    assert.deepEqual(gw.posts, [{ name: 'setPolicyThresholds', input }]);
  });

  it('describes a rule and steps within its floor', () => {
    assert.equal(thresholdLabel(allow), 'auto-allow when verdict is allow');
    assert.equal(thresholdText(allow), 'p(allow) ≥ 0.95');
    assert.equal(thresholdText({ ...allow, value: 0.9 }), 'p(allow) ≥ 0.90 (default 0.95)');
    assert.equal(
      thresholdLabel({ ...allow, action: 'route:fast', kind: 'minConfidence' }),
      'route to fast when verdict is allow',
    );
    assert.equal(thresholdFloor(allow), 0.8);
    assert.equal(thresholdFloor({ ...allow, action: 'deny', floor: 0 }), 0);
    assert.equal(clampThreshold(allow, 0.333), 0.8);
    assert.equal(clampThreshold(allow, 0.876), 0.88);
    assert.equal(clampThreshold(allow, 1.2), 1);
    assert.equal(clampThreshold({ ...allow, action: 'deny', floor: 0.554 }, 0.5), 0.554);
  });

  it('parses typed thresholds as fractions or percentages, refusing out-of-range text', () => {
    assert.deepEqual(parseThresholdInput(allow, '0.9'), { value: 0.9, error: null });
    assert.deepEqual(parseThresholdInput(allow, '.85'), { value: 0.85, error: null });
    assert.deepEqual(parseThresholdInput(allow, '90'), { value: 0.9, error: null });
    assert.deepEqual(parseThresholdInput(allow, '92%'), { value: 0.92, error: null });
    assert.deepEqual(parseThresholdInput(allow, '0,8'), { value: 0.8, error: null });
    assert.deepEqual(parseThresholdInput({ ...allow, action: 'deny', floor: 0.554 }, '0.554'), {
      value: 0.554,
      error: null,
    });
    assert.match(parseThresholdInput(allow, '0.4').error ?? '', /0\.80 to 1\.00/);
    assert.notEqual(parseThresholdInput(allow, 'abc').error, null);
    assert.notEqual(parseThresholdInput(allow, '150').error, null);
    assert.deepEqual(parseThresholdInput({ ...allow, action: 'deny', floor: 0 }, '0.3'), {
      value: 0.3,
      error: null,
    });
  });

  it('tints only the soft warning band of an auto-allow slider at the floor', () => {
    assert.deepEqual(warningZones(allow), [
      { from: ALLOW_THRESHOLD.floor, to: ALLOW_THRESHOLD.soft, strong: false },
    ]);
    assert.deepEqual(warningZones({ ...allow, floor: 0.85 }), [
      { from: 0.85, to: ALLOW_THRESHOLD.soft, strong: false },
    ]);
    assert.deepEqual(warningZones({ ...allow, floor: 0.95 }), []);
    assert.deepEqual(warningZones({ ...allow, action: 'deny' }), []);
    assert.equal(allowWarning(allow, 0.85)?.strong, false);
  });

  it('warns when the auto-allow threshold is lowered, never for deny', () => {
    assert.equal(allowWarning(allow), null);
    assert.equal(allowWarning({ ...allow, value: ALLOW_THRESHOLD.soft }), null);
    assert.equal(allowWarning({ ...allow, value: 0.85 })?.strong, false);
    assert.match(allowWarning({ ...allow, value: 0.85 })?.text ?? '', /without asking you/);
    assert.equal(allowWarning({ ...allow, value: 0.75 })?.strong, true);
    assert.match(allowWarning({ ...allow, value: 0.75 })?.text ?? '', /unsure/);
    assert.equal(allowWarning({ ...allow, action: 'deny', value: 0.3 }), null);
  });

  it('shares the gateway floor', () => {
    assert.equal(ALLOW_THRESHOLD.floor, ALLOW_THRESHOLD_FLOOR);
  });
});

describe('routing settings in config.yaml', () => {
  it('reads Paseo presets and the file, and maps presets through the gateway', async () => {
    const gw = fakeGateway(() => null);
    const d = deps(settings(), gw);
    assert.deepEqual(await routingSettings(d), {
      ok: true,
      error: null,
      file: '/home/u/.config/local-decider/config.yaml',
      presets: { cheap: { model: 'claude/haiku' } },
    });
    await setRoutingPreset(d, { preset: 'deep', model: 'codex/gpt-5.5', mode: 'full-access' });
    await setRoutingPreset(d, { preset: 'cheap', mode: '' });
    assert.deepEqual(gw.posts, [
      {
        name: 'setRoutingPreset',
        input: { harness: 'paseo', preset: 'deep', model: 'codex/gpt-5.5', mode: 'full-access' },
      },
      { name: 'setRoutingPreset', input: { harness: 'paseo', preset: 'cheap' } },
    ]);
  });

  it('reports an older gateway without /v1/config', () => {
    assert.equal(parseRoutingSettings(null).ok, false);
    assert.deepEqual(parseRoutingSettings({ file: null, config: {} }).presets, {});
  });

  it('moves only mapped presets config.yaml does not have yet', () => {
    const saved = {
      fast: { model: 'claude/haiku', modeId: '' },
      deep: { model: 'codex/gpt-5.5', modeId: 'auto' },
      standard: { model: '', modeId: '' },
    };
    assert.deepEqual(legacyPresetMoves(saved, { fast: { model: 'x/y' } }), [
      { preset: 'deep', model: 'codex/gpt-5.5', mode: 'auto' },
    ]);
  });

  it('fetches the authoring prompt and its working directory', async () => {
    const d = deps(
      settings(),
      fakeGateway(() => null),
    );
    assert.deepEqual(await policyPrompt(d, 'routing'), {
      ok: true,
      error: null,
      prompt: '# Write a policy',
      cwd: '/home/u/.config/local-decider',
    });
    assert.equal((await policyPrompt(d, 'permission')).ok, false);
    assert.equal((await policyPrompt(deps(settings(), null), 'routing')).ok, false);
  });
});
