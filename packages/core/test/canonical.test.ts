import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, sortKeysDeep } from '../src/index.ts';

describe('sortKeysDeep', () => {
  it('sorts keys at every depth and keeps array order', () => {
    const input = { b: 1, a: { d: [{ z: 1, y: 2 }], c: null } };
    assert.equal(JSON.stringify(sortKeysDeep(input)), '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('gives the same JSON regardless of insertion order', () => {
    assert.equal(canonicalJson({ x: 1, y: 2 }), canonicalJson({ y: 2, x: 1 }));
  });

  it('passes primitives through', () => {
    assert.equal(sortKeysDeep('s'), 's');
    assert.equal(sortKeysDeep(3), 3);
  });
});
