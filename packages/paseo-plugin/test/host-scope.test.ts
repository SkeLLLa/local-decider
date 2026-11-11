import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_HOST_ID, hostQueryKey } from '../client/host-scope.ts';

describe('hostQueryKey', () => {
  it('gives two hosts distinct keys for the same query', () => {
    const tuxbox = hostQueryKey('tuxbox', 'status');
    const poobox = hostQueryKey('poobox', 'status');
    assert.notDeepEqual(tuxbox, poobox);
    assert.deepEqual(poobox, ['local-decider', 'poobox', 'status']);
  });

  it('keeps gatewayUrl and other parts after the host id', () => {
    assert.deepEqual(hostQueryKey('h', 'engines', 'http://127.0.0.1:8765'), [
      'local-decider',
      'h',
      'engines',
      'http://127.0.0.1:8765',
    ]);
  });

  it('with no parts is the prefix of that host only', () => {
    const prefix = hostQueryKey('poobox');
    const startsWith = (key: readonly unknown[]): boolean =>
      prefix.every((part, i) => key[i] === part);
    assert.ok(startsWith(hostQueryKey('poobox', 'stats')));
    assert.ok(!startsWith(hostQueryKey('tuxbox', 'stats')));
  });

  it('has a constant fallback id', () => {
    assert.equal(hostQueryKey(DEFAULT_HOST_ID, 'x')[1], 'default');
  });
});
