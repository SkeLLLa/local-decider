import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ENGINES } from '../src/engines/registry.ts';

const DOC = new URL('../../../docs/engines.md', import.meta.url);

/** Rows of the first Markdown table in the "Engines" section. */
function engineTableIds(markdown: string): string[] {
  const section = markdown.split(/^## /m).find((part) => part.startsWith('1. Engines')) ?? '';
  return section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => /^\|\s*`([^`]+)`/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
}

describe('docs/engines.md', () => {
  it('lists every registered engine in its engine table, and nothing else', () => {
    const documented = engineTableIds(readFileSync(DOC, 'utf8'));
    assert.deepEqual(documented.toSorted(), ENGINES.map((engine) => engine.id).toSorted());
  });
});
