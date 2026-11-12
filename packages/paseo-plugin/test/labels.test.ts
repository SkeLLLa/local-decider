import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LabelRegistry, recordPermissionLabel } from '../server/labels.ts';
import { LABEL_WINDOW_MS, toRowData, type DecisionRow } from '../shared/row.ts';
import { deps, fakeGateway, fakePaseo, response } from './fakes.ts';

const CLOSED = /can no longer be labelled/;

function drawn(over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    ...toRowData(response({ policy: 'permission', action: 'ask' }), {
      source: 'permission',
      key: 'r1',
      enforced: false,
    }),
    feedback: 'decline',
    answeredAt: 1_000,
    ...over,
  };
}

interface Setup {
  readonly labels: LabelRegistry;
  readonly row: DecisionRow;
  readonly gw: ReturnType<typeof fakeGateway>;
  readonly paseo: ReturnType<typeof fakePaseo>;
  readonly d: ReturnType<typeof deps>;
}

function setup(over: Partial<DecisionRow> = {}, agentId = 'a1'): Setup {
  const labels = new LabelRegistry();
  const row = drawn(over);
  labels.note(agentId, row);
  const gw = fakeGateway(() => null);
  const paseo = fakePaseo([]);
  return { labels, row, gw, paseo, d: deps({} as never, gw) };
}

async function rejected(
  call: (s: Setup) => Promise<unknown>,
  over: Partial<DecisionRow> = {},
): Promise<void> {
  const s = setup(over);
  await assert.rejects(call(s), CLOSED);
  assert.deepEqual(s.gw.outcomes, []);
  assert.deepEqual(s.paseo.agent.appended, []);
}

async function rejectedAt(now: number): Promise<void> {
  await rejected(async (s) =>
    recordPermissionLabel(
      s.d,
      s.paseo,
      s.labels,
      { agentId: 'a1', rowId: s.row.rowId, label: 'unsafe' },
      now,
    ),
  );
}

const autoAllowed = { feedback: null, applied: true, vetoable: true } as const;

describe('recordPermissionLabel', () => {
  it('reports unsafe for the stored decision and redraws the stored row', async () => {
    const { labels, row, gw, paseo, d } = setup();
    const next = await recordPermissionLabel(
      d,
      paseo,
      labels,
      { agentId: 'a1', rowId: row.rowId, label: 'unsafe' },
      1_500,
    );
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'unsafe', source: 'user' }]);
    assert.deepEqual(next, { ...row, label: 'unsafe' });
    assert.equal(paseo.agent.appended.length, 1);
    assert.deepEqual(paseo.agent.appended[0]?.data, { ...row, label: 'unsafe' });
  });

  it('only marks the row for safe and skip', async () => {
    for (const label of ['safe', 'skip'] as const) {
      const { labels, row, gw, paseo, d } = setup();
      const next = await recordPermissionLabel(
        d,
        paseo,
        labels,
        { agentId: 'a1', rowId: row.rowId, label },
        1_500,
      );
      assert.deepEqual(gw.outcomes, []);
      assert.equal(next.label, label);
      assert.equal(paseo.agent.appended.length, 1);
    }
  });

  it('accepts unsafe but not safe on an auto-allowed row', async () => {
    const { labels, row, gw, paseo, d } = setup(autoAllowed);
    const input = { agentId: 'a1', rowId: row.rowId };
    await assert.rejects(
      recordPermissionLabel(d, paseo, labels, { ...input, label: 'safe' }, 1_500),
      CLOSED,
    );
    await recordPermissionLabel(d, paseo, labels, { ...input, label: 'unsafe' }, 1_500);
    assert.equal(gw.outcomes.length, 1);
  });

  describe('rejects', () => {
    it('a forged or unknown row id', async () => {
      await rejected(async (s) =>
        recordPermissionLabel(
          s.d,
          s.paseo,
          s.labels,
          { agentId: 'a1', rowId: 'x', label: 'unsafe' },
          1_500,
        ),
      );
    });

    it('another agent', async () => {
      await rejected(async (s) =>
        recordPermissionLabel(
          s.d,
          s.paseo,
          s.labels,
          { agentId: 'b2', rowId: s.row.rowId, label: 'unsafe' },
          1_500,
        ),
      );
    });

    it('a future answer time and a stale one', async () => {
      await rejectedAt(999);
      await rejectedAt(1_000 + LABEL_WINDOW_MS + 1);
    });

    it('a second label', async () => {
      const s = setup();
      const input = { agentId: 'a1', rowId: s.row.rowId, label: 'unsafe' } as const;
      await recordPermissionLabel(s.d, s.paseo, s.labels, input, 1_500);
      await assert.rejects(recordPermissionLabel(s.d, s.paseo, s.labels, input, 1_500), CLOSED);
      assert.equal(s.gw.outcomes.length, 1);
    });

    it('a restart', async () => {
      await rejected(async (s) =>
        recordPermissionLabel(
          s.d,
          s.paseo,
          new LabelRegistry(),
          { agentId: 'a1', rowId: s.row.rowId, label: 'unsafe' },
          1_500,
        ),
      );
    });
  });

  it('reports a double tap once', async () => {
    const { labels, row, gw, paseo, d } = setup();
    const input = { agentId: 'a1', rowId: row.rowId, label: 'unsafe' } as const;
    const results = await Promise.allSettled([
      recordPermissionLabel(d, paseo, labels, input, 1_500),
      recordPermissionLabel(d, paseo, labels, input, 1_500),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['fulfilled', 'rejected'],
    );
    assert.equal(gw.outcomes.length, 1);
  });

  it('releases the claim when the gateway is down or refuses', async () => {
    const { labels, row, gw, paseo } = setup();
    const input = { agentId: 'a1', rowId: row.rowId, label: 'unsafe' } as const;
    const down = deps({} as never, null);
    await assert.rejects(recordPermissionLabel(down, paseo, labels, input, 1_500), /gateway/);
    const refusing = { ...gw, reportOutcome: async () => false };
    await assert.rejects(
      recordPermissionLabel(deps({} as never, refusing), paseo, labels, input, 1_500),
      /gateway/,
    );
    assert.deepEqual(paseo.agent.appended, []);
    await recordPermissionLabel(deps({} as never, gw), paseo, labels, input, 1_500);
    assert.equal(gw.outcomes.length, 1);
  });

  it('uses the stored decision, not client-sent ones', async () => {
    const { labels, row, gw, paseo, d } = setup();
    // The RPC schema strips extra keys (it can't be imported here: the SDK has no source build);
    // even unstripped, the handler reads the decision only from its own registry.
    const forged = {
      agentId: 'a1',
      rowId: row.rowId,
      label: 'unsafe',
      decisionId: 'x',
      row: { ...row, decisionId: 'x' },
    } as const;
    await recordPermissionLabel(d, paseo, labels, forged, 1_500);
    assert.equal(gw.outcomes[0]?.decisionId, 'd-1');
  });
});

describe('LabelRegistry', () => {
  it('keeps the labelled flag when a row is redrawn', async () => {
    const { labels, row, paseo, d } = setup();
    const input = { agentId: 'a1', rowId: row.rowId, label: 'skip' } as const;
    await recordPermissionLabel(d, paseo, labels, input, 1_500);
    labels.note('a1', row);
    await assert.rejects(recordPermissionLabel(d, paseo, labels, input, 1_500), CLOSED);
  });

  it('does not keep the labelled flag for a different decision', async () => {
    const { labels, row, paseo, d } = setup();
    const input = { agentId: 'a1', rowId: row.rowId, label: 'skip' } as const;
    await recordPermissionLabel(d, paseo, labels, input, 1_500);
    labels.note('a1', { ...row, decisionId: 'other-decision' });
    assert.equal(labels.get('a1', row.rowId)?.labelled, false);
    assert.equal(labels.get('a1', row.rowId)?.decisionId, 'other-decision');
  });

  it('ignores rows without a label kind, a row id or an answer time', () => {
    const labels = new LabelRegistry();
    labels.note('a1', drawn({ feedback: 'allow' }));
    labels.note('a1', drawn({ rowId: '' }));
    labels.note('a1', drawn({ answeredAt: null }));
    assert.equal(labels.get('a1', drawn().rowId), undefined);
    assert.equal(labels.get('a1', ''), undefined);
  });

  it('forgets the oldest entry beyond its bound', () => {
    const labels = new LabelRegistry(2);
    for (const id of ['r1', 'r2', 'r3']) {
      labels.note('a1', drawn({ rowId: id }));
    }
    assert.equal(labels.get('a1', 'r1'), undefined);
    assert.notEqual(labels.get('a1', 'r3'), undefined);
  });
});
