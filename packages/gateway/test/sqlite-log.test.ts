import type { LogRecord, Policy } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PrecedentStore } from '../src/precedent.ts';
import { SqliteLog } from '../src/sqlite-log.ts';
import { tempLog } from './helpers.ts';
import { makeShadowRecord } from './records.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ld-sqlite-test-'));
}

function outcome(decisionId: string, overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    kind: 'outcome',
    ts: '2026-11-10T12:00:00.000Z',
    decisionId,
    outcome: 'allow',
    source: 'user',
    verified: true,
    ...overrides,
  } as LogRecord;
}

function sqlite(): typeof import('node:sqlite') {
  return process.getBuiltinModule('node:sqlite');
}

function pragma(file: string, name: string): number {
  const database = new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true });
  try {
    return Number(database.prepare(`PRAGMA ${name}`).get()?.[name]);
  } finally {
    database.close();
  }
}

describe('SqliteLog', () => {
  it('appends and reads decisions, verified outcomes and usage', () => {
    const log = tempLog();
    try {
      const decision = makeShadowRecord('contract-decision');
      const verified = outcome(decision.decisionId, { ts: decision.ts });
      const usage: LogRecord = {
        kind: 'usage',
        ts: decision.ts,
        decisionId: decision.decisionId,
        turnId: 'turn-1',
        model: 'provider/model',
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        costUsd: 0.01,
      };
      for (const record of [decision, verified, usage]) {
        log.append(record);
      }
      assert.deepEqual(log.read(), [decision, verified, usage]);
    } finally {
      log.close();
    }
  });

  it('filters recent records by the UTC day boundary and prunes old records', () => {
    const log = tempLog();
    try {
      log.append(makeShadowRecord('old', { ts: '2026-08-12T10:00:00.000Z' }));
      log.append(makeShadowRecord('boundary', { ts: '2026-08-13T10:00:00.000Z' }));
      log.append(makeShadowRecord('recent', { ts: '2026-11-10T10:00:00.000Z' }));
      assert.deepEqual(
        log.readRecent(2, Date.parse('2026-11-11T00:00:00.000Z')).map((r) => r.decisionId),
        ['recent'],
      );
      assert.equal(log.prune(90, Date.parse('2026-11-11T00:00:00.000Z')), 1);
      assert.deepEqual(
        log.read().map((r) => r.decisionId),
        ['boundary', 'recent'],
      );
    } finally {
      log.close();
    }
  });

  it('stores verified state, enforces private file modes, and only queries verified precedent', () => {
    const dir = tempDir();
    const file = join(dir, 'data', 'decider.db');
    const log = SqliteLog.open(file);
    try {
      const decision = makeShadowRecord('verified-test', {
        precedentKey: 'sha256:hash',
        ts: '2026-11-10T12:00:00.000Z',
      });
      log.append(decision);
      log.append(
        outcome(decision.decisionId, { outcome: 'deny', source: 'unverified', verified: false }),
      );
      log.append(outcome(decision.decisionId));
      const rows = log.read().filter((row) => row.kind === 'outcome');
      assert.deepEqual(
        rows.map((row) => row.kind === 'outcome' && row.verified),
        [false, true],
      );
      const precedent = log.readVerifiedPrecedent(90, Date.parse('2026-11-11T00:00:00.000Z'));
      assert.equal(precedent.length, 2);
      assert.equal(precedent[1]?.kind === 'outcome' && precedent[1].verified, true);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, 'data')).mode & 0o777, 0o700);
    } finally {
      log.close();
    }
  });

  it('keeps pending ask decisions available for a later verified outcome', () => {
    const log = tempLog();
    try {
      const decision = makeShadowRecord('pending', {
        precedentKey: 'pending-key',
        ts: '2026-11-10T12:00:00.000Z',
      });
      log.append(decision);
      const now = Date.parse('2026-11-11T00:00:00.000Z');
      const recent = log.readVerifiedPrecedent(90, now);
      assert.deepEqual(recent, [decision]);
      const settings = {
        from: 'subject',
        minAllows: 3,
        maxAgeDays: 14,
        sources: ['user'],
      } satisfies NonNullable<Policy['precedent']>;
      const precedent = new PrecedentStore(
        (policy) => (policy === 'permission' ? settings : undefined),
        () => now,
      );
      precedent.rebuild(recent);
      precedent.noteOutcome(
        outcome(decision.decisionId, { ts: '2026-11-10T13:00:00.000Z' }) as never,
      );
      assert.deepEqual(precedent.tally('pending-key'), { allows: 1, denies: 0 });
    } finally {
      log.close();
    }
  });

  it('retention removes old orphan outcomes and usage records', () => {
    const log = tempLog();
    try {
      log.append(outcome('missing-outcome', { ts: '2026-08-12T12:00:00.000Z' }));
      log.append({
        kind: 'usage',
        ts: '2026-08-12T12:00:00.000Z',
        decisionId: 'missing-usage',
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
      });
      assert.equal(log.prune(90, Date.parse('2026-11-11T00:00:00.000Z')), 0);
      assert.deepEqual(log.read(), []);
    } finally {
      log.close();
    }
  });

  it('returns outcomes in append sequence even if timestamps move backwards', () => {
    const log = tempLog();
    try {
      log.append(outcome('same', { outcome: 'deny', ts: '2026-11-10T12:00:00.000Z' }));
      log.append(outcome('same', { outcome: 'allow', ts: '2026-11-09T12:00:00.000Z' }));
      assert.deepEqual(
        log
          .read()
          .filter((record) => record.kind === 'outcome')
          .map((record) => record.outcome),
        ['deny', 'allow'],
      );
    } finally {
      log.close();
    }
  });

  it('exports daily JSONL files filtered by --since', () => {
    const log = tempLog();
    try {
      const first = makeShadowRecord('first', { ts: '2026-11-09T12:00:00.000Z' });
      const second = makeShadowRecord('second', { ts: '2026-11-10T12:00:00.000Z' });
      log.append(first);
      log.append(second);
      const all = join(tempDir(), 'all');
      log.exportDirectory(all);
      assert.deepEqual(readdirSync(all).toSorted(), [
        'decisions-2026-11-09.jsonl',
        'decisions-2026-11-10.jsonl',
      ]);
      assert.deepEqual(
        JSON.parse(readFileSync(join(all, 'decisions-2026-11-10.jsonl'), 'utf8')),
        second,
      );
      assert.equal(statSync(join(all, 'decisions-2026-11-10.jsonl')).mode & 0o777, 0o600);
      const since = join(tempDir(), 'since');
      log.exportDirectory(since, '2026-11-10');
      assert.deepEqual(readdirSync(since), ['decisions-2026-11-10.jsonl']);
    } finally {
      log.close();
    }
  });

  it('serves a read-only handle and backups while a writer is open, and refuses a second writer', () => {
    const dir = tempDir();
    const file = join(dir, 'decider.db');
    const lockPath = join(dir, 'db.lock');
    const writer = SqliteLog.open(file, { lockPath });
    const reader = SqliteLog.open(file, { readOnly: true });
    try {
      writer.append(makeShadowRecord('first'));
      assert.deepEqual(
        reader.read().map((row) => row.decisionId),
        ['first'],
      );
      writer.append(makeShadowRecord('second'));
      assert.deepEqual(
        reader.read().map((row) => row.decisionId),
        ['first', 'second'],
      );
      const backup = join(dir, 'read-only-backup.db');
      const previousUmask = process.umask(0o022);
      try {
        reader.backup(backup);
      } finally {
        process.umask(previousUmask);
      }
      assert.equal(statSync(backup).mode & 0o777, 0o600);
      const original = join(dir, 'existing-backup.db');
      writeFileSync(original, 'keep this file', { mode: 0o600 });
      assert.throws(() => reader.backup(original), /EEXIST/);
      assert.equal(readFileSync(original, 'utf8'), 'keep this file');
      assert.throws(() => SqliteLog.open(file, { lockPath }), /locked by another writer/);
    } finally {
      reader.close();
      writer.close();
    }
    SqliteLog.open(file, { lockPath }).close();
  });

  it('refuses a read-only open of a missing database', () => {
    assert.throws(
      () => SqliteLog.open(join(tempDir(), 'missing.db'), { readOnly: true }),
      /does not exist/,
    );
  });

  it('migrates a version-0 database via user_version and creates the ts indexes', () => {
    const dir = tempDir();
    const file = join(dir, 'decider.db');
    new (sqlite().DatabaseSync)(file, { allowExtension: false }).close();
    assert.equal(pragma(file, 'user_version'), 0);
    SqliteLog.open(file).close();
    assert.equal(pragma(file, 'user_version'), 1);
    SqliteLog.open(file).close();
    assert.equal(pragma(file, 'user_version'), 1);
    const database = new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true });
    try {
      const names = database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")
        .all()
        .map((row) => row['name']);
      for (const index of ['decision_ts', 'outcome_ts', 'usage_ts']) {
        assert.ok(names.includes(index), index);
      }
    } finally {
      database.close();
    }
  });

  it('refuses a database from a newer schema', () => {
    const file = join(tempDir(), 'decider.db');
    const database = new (sqlite().DatabaseSync)(file, { allowExtension: false });
    database.exec('PRAGMA user_version = 99');
    database.close();
    assert.throws(() => SqliteLog.open(file), /newer than this build supports/);
  });

  it('uses incremental auto-vacuum and WAL on new databases', () => {
    const file = join(tempDir(), 'nested', 'decider.db');
    mkdirSync(join(file, '..'), { recursive: true });
    SqliteLog.open(file).close();
    assert.equal(pragma(file, 'auto_vacuum'), 2);
    assert.equal(
      new (sqlite().DatabaseSync)(file, { allowExtension: false, readOnly: true })
        .prepare('PRAGMA journal_mode')
        .get()?.['journal_mode'],
      'wal',
    );
  });
});
