import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildState, CHARS_PER_TOKEN, cutText } from '../src/index.ts';

describe('cutText', () => {
  const text = 'a'.repeat(50) + 'b'.repeat(50);

  it('returns short text unchanged', () => {
    assert.equal(cutText('abc', 10), 'abc');
  });

  for (const keep of ['head', 'tail', 'middle'] as const) {
    it(`fits the budget keeping the ${keep}`, () => {
      const out = cutText(text, 60, keep);
      assert.equal(out.length, 60);
      assert.match(out, /chars truncated/);
    });
  }

  it('keeps the right side', () => {
    assert.ok(cutText(text, 60, 'head').startsWith('a'));
    assert.ok(cutText(text, 60, 'tail').endsWith('b'));
    const mid = cutText(text, 60, 'middle');
    assert.ok(mid.startsWith('a') && mid.endsWith('b'));
  });
});

describe('buildState', () => {
  it('keeps every section when they fit', () => {
    const out = buildState([
      { label: 'History', text: 'old' },
      { label: 'Request', text: 'now' },
    ]);
    assert.equal(out, '## History\nold\n\n## Request\nnow');
  });

  it('spends the budget from the end and stays within it', () => {
    const maxTokens = 100;
    const out = buildState(
      [
        { label: 'History', text: 'h'.repeat(1000) },
        { label: 'Request', text: 'r'.repeat(200) },
      ],
      maxTokens,
    );
    assert.ok(out.length <= maxTokens * CHARS_PER_TOKEN);
    assert.ok(out.endsWith('r'.repeat(200)));
    assert.match(out, /## History\n…\[\d+ chars truncated\]…h+/);
  });

  it('drops leading sections once there is no useful room', () => {
    const out = buildState(
      [
        { label: 'Old', text: 'o'.repeat(500) },
        { label: 'New', text: 'n'.repeat(380) },
      ],
      100,
    );
    assert.ok(!out.includes('## Old'));
  });

  it('skips empty sections and is deterministic', () => {
    const sections = [
      { label: 'Empty', text: '  ' },
      { label: 'X', text: 'x' },
    ];
    assert.equal(buildState(sections), buildState(sections));
    assert.equal(buildState(sections), '## X\nx');
  });
});
