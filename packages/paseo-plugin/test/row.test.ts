import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DECIDE_USAGE, manualInput, parseDecideArgs } from '../shared/manual.ts';
import { nextPollDelay, POLL_MAX_MS, POLL_UP_MS, statusLabel } from '../shared/poll.ts';
import {
  decisionRowSchema,
  rowDetail,
  rowId,
  rowSummary,
  shortModel,
  toRowData,
} from '../shared/row.ts';
import { response } from './fakes.ts';

describe('toRowData', () => {
  it('maps a response to schema-valid row data', () => {
    const row = toRowData(response(), { source: 'turn', enforced: false });
    assert.deepEqual(decisionRowSchema.parse(row), row);
    assert.equal(row.question, 'outcome');
    assert.equal(row.answer, 'done');
    assert.equal(row.attention, false);
    assert.equal(row.error, null);
    assert.equal(rowSummary(row), 'turn-outcome · done 80% · log · shadow');
    assert.equal(rowDetail(row), '2B-qwen3.5-v1-2610 · 120 ms');
  });

  it('flags attention only for an enforced notify', () => {
    const res = response({ action: 'notify', mode: 'act', enforced: true });
    assert.equal(toRowData(res, { source: 'turn', enforced: true }).attention, true);
    const shadow = toRowData(res, { source: 'turn', enforced: false });
    assert.equal(shadow.attention, false);
    assert.equal(rowSummary(shadow), 'turn-outcome · done 80% · notify · act (plugin: shadow)');
  });

  it('handles an engine error without answers', () => {
    const row = toRowData(response({ answers: {}, error: 'engine down', action: 'log' }), {
      source: 'manual',
      enforced: false,
      note: 'via /decide',
    });
    assert.equal(row.answer, '');
    assert.equal(rowSummary(row), 'turn-outcome · no answer · log · shadow');
    assert.equal(
      rowDetail(row),
      'via /decide · 2B-qwen3.5-v1-2610 · 120 ms · engine error: engine down',
    );
  });

  it('builds stable row ids', () => {
    assert.equal(rowId('turn', 't1'), 'local-decider-turn-t1');
    assert.equal(rowId('turn', 't1'), rowId('turn', 't1'));
  });

  it('shortens model names', () => {
    assert.equal(
      shortModel('StrandsAgents/strands-decider-E4B-gemma4-v1-2610'),
      'E4B-gemma4-v1-2610',
    );
    assert.equal(shortModel('other'), 'other');
  });
});

describe('polling', () => {
  it('polls steadily while up and backs off while down', () => {
    assert.equal(nextPollDelay(0), POLL_UP_MS);
    assert.equal(nextPollDelay(1), POLL_UP_MS);
    assert.equal(nextPollDelay(2), POLL_UP_MS * 2);
    assert.equal(nextPollDelay(3), POLL_UP_MS * 4);
    assert.equal(nextPollDelay(50), POLL_MAX_MS);
    assert.equal(nextPollDelay(Number.NaN), POLL_UP_MS);
  });

  it('labels the sidebar row', () => {
    assert.equal(statusLabel(undefined, shortModel), 'Decider · …');
    assert.equal(
      statusLabel({ up: false, model: null, p50Ms: null }, shortModel),
      'Decider · down',
    );
    assert.equal(
      statusLabel(
        { up: true, model: 'StrandsAgents/strands-decider-2B-hobson-v21', p50Ms: 87.4 },
        shortModel,
      ),
      'Decider · 2B-hobson-v21 · 87 ms',
    );
  });
});

describe('/decide arguments', () => {
  it('parses a policy and free text', () => {
    assert.deepEqual(parseDecideArgs('routing  add a flag\nplease'), {
      policy: 'routing',
      text: 'add a flag\nplease',
    });
    assert.equal(parseDecideArgs('routing'), null);
    assert.equal(parseDecideArgs(''), null);
    assert.equal(parseDecideArgs('Bad! text'), null);
    assert.match(DECIDE_USAGE, /\/decide <policy> <text>/);
  });

  it('fills the input key each default policy reads', () => {
    assert.deepEqual(manualInput('routing', 'x'), { prompt: 'x' });
    assert.deepEqual(manualInput('command-risk', 'rm -rf /'), { command: 'rm -rf /' });
    assert.deepEqual(manualInput('custom', 'x'), { text: 'x' });
  });
});
