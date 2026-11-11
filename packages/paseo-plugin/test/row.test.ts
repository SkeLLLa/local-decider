import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DecideResponse } from '../shared/decision.ts';
import { DECIDE_USAGE, manualInput, parseDecideArgs } from '../shared/manual.ts';
import { compactModel, shortModel } from '../shared/models.ts';
import {
  nextPollDelay,
  POLL_MAX_MS,
  POLL_UP_MS,
  compactMs,
  ellipsis,
  statusLabel,
  statusSummary,
} from '../shared/poll.ts';
import {
  decisionRowSchema,
  rowDetail,
  rowId,
  rowSummary,
  rowVisible,
  toRowData,
} from '../shared/row.ts';
import { response } from './fakes.ts';

function permission(confidence: number, action: string, mode: 'act' | 'shadow'): DecideResponse {
  return response({
    policy: 'permission',
    action,
    mode,
    enforced: mode === 'act',
    answers: { decision: { type: 'choice', answer: 'allow', probabilities: {}, confidence } },
  });
}

describe('toRowData', () => {
  it('maps a response to schema-valid row data', () => {
    const row = toRowData(response(), { source: 'turn', key: 't1', enforced: false });
    assert.deepEqual(decisionRowSchema.parse(row), row);
    assert.equal(row.question, 'outcome');
    assert.equal(row.answer, 'done');
    assert.equal(row.attention, false);
    assert.equal(row.error, null);
    assert.equal(rowSummary(row), 'turn-outcome · log · leaned done 80% · shadow');
    assert.equal(rowDetail(row), '2B-qwen3.5-v1-2610 · 120 ms');
  });

  it('flags attention only for an enforced notify', () => {
    const res = response({ action: 'notify', mode: 'act', enforced: true });
    assert.equal(toRowData(res, { source: 'turn', key: 't1', enforced: true }).attention, true);
    const shadow = toRowData(res, { source: 'turn', key: 't1', enforced: false });
    assert.equal(shadow.attention, false);
    assert.equal(
      rowSummary(shadow),
      'turn-outcome · notify · leaned done 80% · act (plugin: shadow)',
    );
  });

  it('handles an engine error without answers', () => {
    const row = toRowData(response({ answers: {}, error: 'engine down', action: 'log' }), {
      source: 'manual',
      key: 'd-1',
      enforced: false,
      note: 'via /decide',
    });
    assert.equal(row.answer, '');
    assert.equal(rowSummary(row), 'turn-outcome · log · no answer · shadow');
    assert.equal(
      rowDetail(row),
      'via /decide · 2B-qwen3.5-v1-2610 · 120 ms · engine error: engine down',
    );
  });

  it('leads permission rows with what happened and never presents a weak answer', () => {
    const weak = toRowData(permission(0.09, 'ask', 'act'), {
      source: 'permission',
      key: 'r1',
      enforced: true,
    });
    assert.equal(rowSummary(weak), 'permission · asked you · unsure 9% · act');
    const allowed = toRowData(permission(0.97, 'allow', 'act'), {
      source: 'permission',
      key: 'r1',
      enforced: true,
      applied: true,
    });
    assert.equal(rowSummary(allowed), 'permission · auto-allowed · leaned allow 97% · act');
    const shadow = toRowData(permission(0.72, 'allow', 'shadow'), {
      source: 'permission',
      key: 'r1',
      enforced: false,
    });
    assert.equal(
      rowSummary(shadow),
      'permission · asked you · would auto-allow · leaned allow 72% · shadow',
    );
  });

  it('carries its row id and feedback options', () => {
    const row = toRowData(response(), { source: 'turn', key: 't1', enforced: false });
    assert.equal(row.rowId, rowId('turn', 't1'));
    assert.deepEqual(row.options, ['done', 'stuck']);
    assert.equal(row.feedback, null);
  });

  it('parses rows from older versions without the new fields', () => {
    const {
      rowId: _id,
      options: _o,
      feedback: _f,
      ...old
    } = toRowData(response(), {
      source: 'turn',
      key: 't1',
      enforced: false,
    });
    const row = decisionRowSchema.parse(old);
    assert.equal(row.rowId, '');
    assert.deepEqual(row.options, []);
  });

  it('filters rows by visibility', () => {
    const plain = toRowData(response(), { source: 'turn', key: 't', enforced: false });
    const unsure = toRowData(
      response({
        answers: {
          outcome: { type: 'choice', answer: 'done', probabilities: {}, confidence: 0.5 },
        },
      }),
      { source: 'turn', key: 't', enforced: false },
    );
    const manual = { ...plain, source: 'manual' as const };
    assert.equal(rowVisible(plain, 'all'), true);
    assert.equal(rowVisible(plain, 'notable'), false);
    assert.equal(rowVisible(unsure, 'notable'), true);
    assert.equal(rowVisible({ ...plain, applied: true }, 'notable'), true);
    assert.equal(rowVisible({ ...plain, error: 'x' }, 'notable'), true);
    const routine = { ...plain, enforced: true };
    assert.equal(rowVisible(routine, 'notable'), false, 'an enforced log is routine');
    assert.equal(rowVisible({ ...unsure, enforced: true }, 'notable'), false);
    assert.equal(rowVisible({ ...routine, attention: true }, 'notable'), true);
    assert.equal(rowVisible(plain, 'off'), false);
    assert.equal(rowVisible(manual, 'off'), true);
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
    const up = { up: true, model: 'StrandsAgents/strands-decider-2B-hobson-v21', p50Ms: 87.4 };
    assert.equal(statusLabel(undefined), 'Decider…');
    assert.equal(statusLabel({ up: false, model: null, p50Ms: null }), 'Offline');
    assert.equal(statusLabel({ ...up, status: 'degraded' }), 'Loading…');
    assert.equal(statusLabel(up), 'hobson 2B · 87ms');
    assert.equal(statusLabel({ ...up, p50Ms: 7847 }), 'hobson 2B · 7.8s');
    assert.equal(statusLabel(up, 'model'), 'hobson 2B');
    assert.equal(statusLabel(up, 'latency'), '87ms');
    assert.equal(statusLabel(up, 'minimal'), 'Decider');
    assert.equal(
      statusLabel({ ...up, model: 'someone/a-very-long-custom-model-name' }),
      'someone/a-very-long-c…',
    );
  });

  it('names the engine in the sidebar label when it fits', () => {
    const npu = { up: true, engine: 'fastflowlm', engineTag: 'NPU', model: 'd3:nano', p50Ms: 300 };
    assert.equal(statusLabel(npu), 'd3:nano · NPU · 300ms');
    assert.equal(statusLabel(npu, 'model'), 'd3:nano · NPU');
    assert.equal(statusLabel(npu, 'latency'), '300ms');
    const strands = {
      up: true,
      engine: 'strands-decider',
      engineTag: 'PyTorch',
      model: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
      p50Ms: 8487,
    };
    assert.equal(statusLabel(strands), 'qwen3.5 2B · 8.5s');
    assert.equal(statusLabel(strands, 'model'), 'qwen3.5 2B · PyTorch');
  });

  it('shortens models and latency for the sidebar', () => {
    assert.equal(compactModel('StrandsAgents/strands-decider-2B-qwen3.5-v1-2610'), 'qwen3.5 2B');
    assert.equal(compactModel('StrandsAgents/strands-decider-E4B-gemma4-v1-2610'), 'gemma4 E4B');
    assert.equal(compactModel('custom/x'), 'custom/x');
    assert.equal(compactMs(850.4), '850ms');
    assert.equal(compactMs(12_400), '12s');
    assert.equal(ellipsis('abcdef', 4), 'abc…');
    assert.equal(ellipsis('abc', 4), 'abc');
  });

  it('summarises the status for settings', () => {
    const base = { gatewayUrl: 'http://127.0.0.1:8765', detail: null, p50Ms: null, model: null };
    assert.match(statusSummary({ ...base, up: false, engineState: null }), /Unreachable at/);
    assert.equal(
      statusSummary({
        ...base,
        up: true,
        engineState: 'starting',
        model: 'StrandsAgents/strands-decider-2B-hobson-v21',
        detail: 'restart 1',
      }),
      'starting · 2B-hobson-v21 · restart 1',
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
