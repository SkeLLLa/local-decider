import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inputHash } from '../src/index.ts';

describe('inputHash', () => {
  it('ignores key order and is hex sha256', () => {
    assert.equal(inputHash({ a: 1, b: 2 }), inputHash({ b: 2, a: 1 }));
    assert.match(inputHash('x'), /^[0-9a-f]{64}$/);
  });
});
