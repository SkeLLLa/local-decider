import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  listPolicyVariants,
  policyPrompt,
  reloadPolicies,
  routingSettings,
  setPolicyVariant,
  setRoutingPreset,
} from '../server/engines.ts';
import {
  legacyPresetMoves,
  parsePolicyVariants,
  parseRoutingSettings,
  presetRows,
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
