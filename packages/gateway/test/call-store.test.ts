import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CallStore, type CallDecision } from '../src/call-store.ts';

const decision = (id: string): CallDecision => ({
  decisionId: id,
  action: 'log',
  enforced: false,
  answered: true,
});

describe('CallStore', () => {
  it('merges decisions of several policies under one call id', () => {
    const store = new CallStore();
    store.note('c1', 'command-risk', decision('d1'), 'auto');
    store.note('c1', 'permission', decision('d2'));
    assert.deepEqual(store.get('c1'), {
      permissionMode: 'auto',
      decisions: { 'command-risk': decision('d1'), 'permission': decision('d2') },
    });
    assert.equal(store.get('missing'), undefined);
  });

  it('expires entries after the TTL', () => {
    let now = 1000;
    const store = new CallStore({ now: () => now, ttlMs: 100 });
    store.note('c1', 'p', decision('d1'));
    now += 99;
    assert.ok(store.get('c1'));
    now += 1;
    assert.equal(store.get('c1'), undefined);
    assert.equal(store.size, 0);
  });

  it('evicts the least recently written entry past the maximum', () => {
    const store = new CallStore({ max: 2 });
    store.note('a', 'p', decision('1'));
    store.note('b', 'p', decision('2'));
    store.note('a', 'q', decision('3'));
    store.note('c', 'p', decision('4'));
    assert.equal(store.get('b'), undefined);
    assert.ok(store.get('a'));
    assert.ok(store.get('c'));
  });
});
