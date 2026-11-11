import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { Paths } from '../src/paths.ts';
import { ensureReportToken } from '../src/report-token.ts';

describe('ensureReportToken', () => {
  it('creates a private token once and reuses it', () => {
    const data = mkdtempSync(join(tmpdir(), 'ld-token-test-'));
    const testPaths: Paths = {
      data,
      config: join(data, 'config'),
      logs: join(data, 'logs'),
      venvs: join(data, 'venvs'),
      engines: join(data, 'engines'),
      run: join(data, 'run'),
    };
    const first = ensureReportToken(testPaths);
    assert.equal(Buffer.from(first, 'base64url').byteLength, 32);
    assert.equal(ensureReportToken(testPaths), first);
    assert.equal(readFileSync(join(testPaths.config, 'report-token'), 'utf8'), first);
    assert.equal(statSync(join(testPaths.config, 'report-token')).mode & 0o777, 0o600);
  });
});
