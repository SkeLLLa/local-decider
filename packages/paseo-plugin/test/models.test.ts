import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createModelKeeper } from '../server/model.ts';
import { recordFeedback, selectModel } from '../server/rpc.ts';
import { decisionModelOptions, gatewayCatalog, pendingSelection } from '../shared/models.ts';
import { toRowData } from '../shared/row.ts';
import { migrateV1, settingsSchema } from '../shared/settings-schema.ts';
import { deps, fakeGateway, fakePaseo, response, settings } from './fakes.ts';

const QWEN = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';
const GEMMA = 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610';

describe('model catalog', () => {
  it('reads the gateway catalog and older list shapes', () => {
    assert.deepEqual(
      gatewayCatalog({
        active: QWEN,
        device: 'cpu',
        switchable: true,
        models: [{ id: QWEN, memoryGb: 8 }, { name: 'b' }, 3, null, { id: QWEN }],
      }),
      {
        active: QWEN,
        device: 'cpu',
        switchable: true,
        models: [
          { id: QWEN, memoryGb: 8 },
          { id: 'b', memoryGb: null },
        ],
      },
    );
    assert.deepEqual(gatewayCatalog(['a', 'a']).models, [{ id: 'a', memoryGb: null }]);
    assert.deepEqual(gatewayCatalog(null), {
      active: null,
      device: null,
      switchable: false,
      models: [],
    });
  });

  it('offers gateway config first, then models with memory, then the saved value', () => {
    const options = decisionModelOptions(
      { active: QWEN, models: [{ id: 'StrandsAgents/new-model', memoryGb: 4 }] },
      'custom/x',
    );
    assert.deepEqual(options[0], { label: 'Gateway config (2B-qwen3.5-v1-2610)', value: '' });
    assert.deepEqual(options[1], { label: 'new-model · ~4 GB', value: 'StrandsAgents/new-model' });
    assert.equal(options.at(-1)?.value, 'custom/x');
    assert.ok(options.some((o) => o.value === QWEN));
  });

  it('knows when the gateway already serves the choice', () => {
    const live = { model: QWEN, device: 'cpu' };
    assert.equal(pendingSelection({ model: '', device: 'auto' }, live), null);
    assert.equal(pendingSelection({ model: QWEN, device: 'auto' }, live), null);
    assert.equal(pendingSelection({ model: QWEN, device: 'cpu' }, live), null);
    assert.deepEqual(pendingSelection({ model: QWEN, device: 'cuda' }, live), {
      model: QWEN,
      device: 'cuda',
    });
    assert.deepEqual(pendingSelection({ model: GEMMA, device: 'auto' }, live), {
      model: GEMMA,
      device: 'auto',
    });
  });
});

describe('settings migration', () => {
  it('drops the v1 engine and the untouched default model', () => {
    const v1 = { engine: 'strands-decider', model: QWEN, device: 'auto', injectMcp: true };
    const migrated = settingsSchema.parse(migrateV1(v1));
    assert.equal(migrated.model, '');
    assert.equal(migrated.injectMcp, true);
    assert.equal(migrated.sidebar.position, 'footer');
    assert.equal(migrated.rows.show, 'all');
    assert.equal('engine' in migrated, false);
  });

  it('keeps a model the user picked', () => {
    const migrated = settingsSchema.parse(migrateV1({ model: GEMMA }));
    assert.equal(migrated.model, GEMMA);
  });
});

function catalogGateway(active: string, switchable = true): ReturnType<typeof fakeGateway> {
  const gw = fakeGateway(() => null);
  return { ...gw, models: async () => ({ active, device: 'cpu', switchable, models: [] }) };
}

describe('model keeper', () => {
  it('switches the gateway back once per retry window', async () => {
    const gw = catalogGateway(QWEN);
    let now = 0;
    const keep = createModelKeeper(
      deps(settings({ model: GEMMA, keepModel: true }), gw),
      () => now,
    );
    await keep();
    await keep();
    assert.deepEqual(gw.selections, [{ model: GEMMA, device: 'auto' }]);
    now += 11 * 60_000;
    await keep();
    assert.equal(gw.selections.length, 2);
  });

  it('does nothing when off, already served, or not switchable', async () => {
    for (const [s, gw] of [
      [settings({ model: GEMMA, keepModel: false }), catalogGateway(QWEN)],
      [settings({ model: '', keepModel: true }), catalogGateway(QWEN)],
      [settings({ model: GEMMA, keepModel: true }), catalogGateway(GEMMA)],
      [settings({ model: GEMMA, keepModel: true }), catalogGateway(QWEN, false)],
    ] as const) {
      await createModelKeeper(deps(s, gw))();
      assert.deepEqual(gw.selections, []);
    }
  });
});

describe('model and feedback RPCs', () => {
  it('forwards a model switch and reports failures', async () => {
    const gw = fakeGateway(() => null);
    assert.deepEqual(await selectModel(deps(settings(), gw), { model: GEMMA, device: 'cpu' }), {
      ok: true,
      error: null,
    });
    const failing = {
      ...gw,
      selectEngine: async () => ({ ok: false as const, error: 'HTTP 409' }),
    };
    assert.deepEqual(
      await selectModel(deps(settings(), failing), { model: GEMMA, device: 'cpu' }),
      {
        ok: false,
        error: 'HTTP 409',
      },
    );
    assert.equal(
      (await selectModel(deps(settings(), null), { model: GEMMA, device: 'cpu' })).ok,
      false,
    );
  });

  it('reports feedback as a user outcome and redraws the row', async () => {
    const gw = fakeGateway(() => null);
    const paseo = fakePaseo([]);
    const row = toRowData(response(), { source: 'turn', key: 't1', enforced: false });
    const next = await recordFeedback(deps(settings(), gw), paseo, {
      agentId: 'a1',
      row,
      outcome: 'stuck',
    });
    assert.equal(next.feedback, 'stuck');
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'stuck', source: 'user' }]);
    assert.equal(paseo.agent.appended[0]?.id, row.rowId);
    const appended = paseo.agent.appended[0];
    assert.ok(appended !== undefined);
    assert.equal((appended.data as { feedback: string }).feedback, 'stuck');
  });

  it('rejects unknown options and an unreachable gateway', async () => {
    const row = toRowData(response(), { source: 'turn', key: 't1', enforced: false });
    const paseo = fakePaseo([]);
    await assert.rejects(
      recordFeedback(
        deps(
          settings(),
          fakeGateway(() => null),
        ),
        paseo,
        {
          agentId: 'a1',
          row,
          outcome: 'nope',
        },
      ),
      /not an option/,
    );
    const down = { ...fakeGateway(() => null), reportOutcome: async () => false };
    await assert.rejects(
      recordFeedback(deps(settings(), down), paseo, { agentId: 'a1', row, outcome: 'done' }),
      /did not record/,
    );
    assert.equal(paseo.agent.appended.length, 0);
  });
});
