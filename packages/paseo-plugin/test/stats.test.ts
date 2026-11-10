import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkedAgo } from '../shared/poll.ts';
import { actionSummary, formatMs, formatPercent, parsePolicyStats } from '../shared/stats.ts';

describe('stats', () => {
  it('reads gateway stats tolerantly', () => {
    const [turn, bad] = [
      {
        policy: 'turn-outcome',
        decisions: 11,
        errors: 1,
        enforced: 0,
        actions: { notify: 1, log: 10 },
        latencyP50Ms: 2564,
        labelled: 0,
        reliability: [],
      },
      { decisions: 3 },
    ];
    const parsed = parsePolicyStats([turn, bad, null]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.agreement, null);
    assert.equal(parsed[0]?.latencyP95Ms, null);
    assert.deepEqual(parsePolicyStats({ nope: 1 }), []);
  });

  it('formats actions, latency and percentages', () => {
    assert.equal(actionSummary({ notify: 1, log: 10 }), 'log 10 · notify 1');
    assert.equal(formatMs(850.4), '850 ms');
    assert.equal(formatMs(2564), '2.6 s');
    assert.equal(formatMs(null), '—');
    assert.equal(formatPercent(0.876), '88%');
  });

  it('says how long ago a check ran', () => {
    const now = Date.parse('2026-11-10T13:15:00Z');
    assert.equal(checkedAgo('2026-11-10T13:14:58Z', now), 'just now');
    assert.equal(checkedAgo('2026-11-10T13:14:18Z', now), '42 s ago');
    assert.equal(checkedAgo('2026-11-10T13:05:00Z', now), '10 min ago');
    assert.equal(checkedAgo(undefined, now), '—');
  });
});
