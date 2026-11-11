import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEngineLogFilter, filterEngineLine } from '../../src/engines/log-filter.ts';

async function filterChunks(chunks: readonly string[]): Promise<string> {
  const filter = createEngineLogFilter();
  const output: Buffer[] = [];
  filter.on('data', (chunk: Buffer) => output.push(chunk));
  for (const chunk of chunks) {
    filter.write(chunk);
  }
  filter.end();
  await new Promise<void>((resolve, reject) => {
    filter.once('end', resolve);
    filter.once('error', reject);
  });
  return Buffer.concat(output).toString('utf8');
}

describe('engine output filter', () => {
  it('drops request payload lines and oversized output but keeps status lines', () => {
    const requestLines = [
      '{"state":"## Project /private/work ## Command git status","questions":{"verdict":{}}}',
      '{"questions":{"verdict":{"criteria":{"allow":"safe"}}}}',
    ];
    assert.equal(filterEngineLine(requestLines[0] ?? ''), undefined);
    assert.equal(filterEngineLine(requestLines[1] ?? ''), undefined);
    assert.equal(
      filterEngineLine('server ready on 127.0.0.1:8080'),
      'server ready on 127.0.0.1:8080',
    );
    assert.equal(filterEngineLine('x'.repeat(501)), undefined);
    assert.equal(filterEngineLine('x'.repeat(500))?.length, 500);
  });

  it('filters complete lines across arbitrary child stream chunks', async () => {
    const result = await filterChunks([
      'server ready\n{"sta',
      `te":"private text"}\nrequest complete\n${'x'.repeat(251)}`,
      `${'x'.repeat(250)}\npartial status`,
    ]);
    assert.equal(result, 'server ready\nrequest complete\npartial status\n');
  });
});
