import assert from 'node:assert/strict';
import { chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { llamaServerVersion } from '../src/engines/llama/version.ts';
import { tempPaths } from './helpers.ts';

function executable(file: string, output: string): void {
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(file, 0o700);
}

describe('llama-server version stamp', () => {
  it('parses the version and invalidates the cache when the binary mtime changes', async () => {
    const file = join(tempPaths().data, 'llama-server');
    executable(file, 'version: 12318');
    assert.equal(await llamaServerVersion(file), 'b12318');
    executable(file, 'version: 12319');
    utimesSync(file, new Date(), new Date(Date.now() + 2000));
    assert.equal(await llamaServerVersion(file), 'b12319');
  });

  it('falls back to a binary size and mtime stamp and returns null without a binary', async () => {
    const file = join(tempPaths().data, 'llama-server');
    executable(file, 'no version available');
    const stat = await import('node:fs').then(({ statSync }) => statSync(file));
    assert.equal(await llamaServerVersion(file), `stamp:${String(stat.size)}-${String(stat.mtimeMs)}`);
    assert.equal(await llamaServerVersion(undefined), null);
  });
});
