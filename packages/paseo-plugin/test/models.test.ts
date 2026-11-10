import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recordFeedback } from '../server/rpc.ts';
import { toRowData } from '../shared/row.ts';
import {
  migrateSettings,
  migrateStored,
  SETTINGS_VERSION,
  settingsSchema,
} from '../shared/settings-schema.ts';
import { deps, fakeGateway, fakePaseo, response, settings } from './fakes.ts';

const QWEN = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';

describe('settings migration', () => {
  it('drops the v1 engine and the v2 model, device and keep switch', () => {
    for (const old of [
      { engine: 'strands-decider', model: QWEN, device: 'auto', injectMcp: true },
      { model: QWEN, device: 'cuda', keepModel: true, injectMcp: true },
    ]) {
      const migrated = settingsSchema.parse(migrateSettings(old));
      assert.equal(migrated.injectMcp, true);
      assert.equal(migrated.sidebar.position, 'footer');
      assert.equal(migrated.rows.show, 'all');
      for (const key of ['engine', 'model', 'device', 'keepModel']) {
        assert.equal(key in migrated, false, key);
      }
    }
  });

  it('keeps everything else and survives junk', () => {
    const migrated = settingsSchema.parse(
      migrateSettings({ gatewayUrl: 'http://127.0.0.1:9000', rows: { show: 'off' } }),
    );
    assert.equal(migrated.gatewayUrl, 'http://127.0.0.1:9000');
    assert.equal(migrated.rows.show, 'off');
    assert.deepEqual(migrateSettings(null), {});
    assert.deepEqual(migrateSettings([1]), {});
  });

  it('is version 3 and migrates anything older', () => {
    assert.equal(SETTINGS_VERSION, 3);
    assert.deepEqual(migrateStored({ model: QWEN, keepModel: true, injectMcp: true }, 2), {
      injectMcp: true,
    });
    assert.deepEqual(migrateStored({ injectMcp: true }, 3), { injectMcp: true });
  });
});

describe('feedback RPC', () => {
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
