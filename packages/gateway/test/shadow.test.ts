import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ShadowLog } from '../src/shadow.ts';
import { logStoreContract } from './log-store-contract.ts';
import { makeShadowRecord } from './records.ts';

function tempLogDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'ld-shadow-test-')), 'logs');
}

logStoreContract('ShadowLog', () => new ShadowLog(tempLogDir()));

describe('ShadowLog', () => {
  it('prunes only dated decision files older than the retention boundary', () => {
    const logs = tempLogDir();
    mkdirSync(logs, { recursive: true });
    const old = join(logs, 'decisions-2026-08-12.jsonl');
    const boundary = join(logs, 'decisions-2026-08-13.jsonl');
    const unrelated = join(logs, 'engine-fastflowlm.log');
    for (const path of [old, boundary, unrelated]) {
      writeFileSync(path, 'data');
    }
    assert.equal(new ShadowLog(logs).prune(90, Date.parse('2026-11-11T00:00:00.000Z')), 1);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(boundary), true);
    assert.equal(existsSync(unrelated), true);
  });

  it('repairs a torn final line before the first append to a file', () => {
    const logs = tempLogDir();
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, 'decisions-2026-11-10.jsonl'), '{"kind":"decision"');
    const log = new ShadowLog(logs);
    const record = makeShadowRecord('decision-1', { ts: '2026-11-10T12:00:00.000Z' });
    log.append(record);
    assert.deepEqual(log.read(), [record]);
  });
});
