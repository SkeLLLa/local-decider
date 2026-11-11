import type { LogRecord, Policy } from '@local-decider/core';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PrecedentStore } from '../src/precedent.ts';
import { ShadowLog, type LogStore } from '../src/shadow.ts';
import { openLogStore, SqliteLog, SqliteUnavailableError } from '../src/sqlite-log.ts';
import { logStoreContract } from './log-store-contract.ts';
import { makeShadowRecord } from './records.ts';

interface TestPaths {
  readonly data: string;
  readonly logs: string;
  readonly run: string;
  readonly config: string;
  readonly venvs: string;
  readonly engines: string;
}

function tempPaths(): TestPaths {
  const root = mkdtempSync(join(tmpdir(), 'ld-sqlite-test-'));
  const paths = {
    data: join(root, 'data'),
    logs: join(root, 'data', 'logs'),
    run: join(root, 'data', 'run'),
    config: join(root, 'config'),
    venvs: join(root, 'data', 'venvs'),
    engines: join(root, 'data', 'engines'),
  };
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  return paths;
}

async function open(paths: TestPaths, readOnly = false): Promise<SqliteLog> {
  return SqliteLog.open(join(paths.data, 'decider.db'), paths.logs, {
    readOnly,
    ...(readOnly ? {} : { lockPath: join(paths.run, 'db.lock') }),
  });
}

function close(log: LogStore): void {
  (log as LogStore & { close?: () => void }).close?.();
}

logStoreContract('SqliteLog', async () => open(tempPaths()));

describe('SqliteLog', () => {
  it('stores verified state, enforces private file modes, and only queries verified precedent', async () => {
    const paths = tempPaths();
    const log = await open(paths);
    try {
      const decision = makeShadowRecord('verified-test', {
        precedentKey: 'sha256:hash',
        ts: '2026-11-10T12:00:00.000Z',
      });
      log.append(decision);
      log.append({
        kind: 'outcome',
        ts: decision.ts,
        decisionId: decision.decisionId,
        outcome: 'deny',
        source: 'unverified',
        verified: false,
      });
      log.append({
        kind: 'outcome',
        ts: decision.ts,
        decisionId: decision.decisionId,
        outcome: 'allow',
        source: 'user',
        verified: true,
      });
      const outcome = log.read().filter((row) => row.kind === 'outcome');
      assert.deepEqual(
        outcome.map((row) => row.kind === 'outcome' && row.verified),
        [false, true],
      );
      const precedent = log.readVerifiedPrecedent(90, Date.parse('2026-11-11T00:00:00.000Z'));
      assert.equal(precedent.length, 2);
      assert.equal(precedent[1]?.kind === 'outcome' && precedent[1].verified, true);
      assert.equal(statSync(join(paths.data, 'decider.db')).mode & 0o777, 0o600);
      assert.equal(statSync(paths.data).mode & 0o777, 0o700);
    } finally {
      log.close();
    }
  });

  it('keeps a read-only CLI connection current while the gateway writes', async () => {
    const paths = tempPaths();
    const writer = await open(paths);
    const reader = await open(paths, true);
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
      const backup = join(paths.data, 'read-only-backup.db');
      const previousUmask = process.umask(0o022);
      try {
        reader.backup(backup);
      } finally {
        process.umask(previousUmask);
      }
      assert.equal(statSync(backup).mode & 0o777, 0o600);
      const original = join(paths.data, 'existing-backup.db');
      writeFileSync(original, 'keep this file', { mode: 0o600 });
      assert.throws(() => reader.backup(original), /EEXIST/);
      assert.equal(readFileSync(original, 'utf8'), 'keep this file');
      await assert.rejects(open(paths), /locked by another writer/);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('imports JSONL idempotently and exports records that can be imported again', async () => {
    const paths = tempPaths();
    const source = join(paths.data, 'legacy');
    mkdirSync(source, { recursive: true });
    const decision = makeShadowRecord('portable', { ts: '2026-11-10T12:00:00.000Z' });
    const outcome: LogRecord = {
      kind: 'outcome',
      ts: decision.ts,
      decisionId: decision.decisionId,
      outcome: 'allow',
      source: 'user',
      verified: true,
    };
    writeFileSync(
      join(source, 'decisions-2026-11-10.jsonl'),
      `${JSON.stringify(decision)}\n${JSON.stringify(outcome)}\n`,
      { mode: 0o600 },
    );
    const log = await open(paths);
    try {
      assert.equal(log.importDirectory(source), 2);
      assert.equal(log.importDirectory(source), 0);
      assert.deepEqual(log.read(), [decision, outcome]);
      const backup = join(paths.data, 'backup.db');
      log.backup(backup);
      assert.equal(statSync(backup).mode & 0o777, 0o600);
      const exported = join(paths.data, 'exported');
      log.exportDirectory(exported);
      const reimport = await SqliteLog.open(
        join(paths.data, 'second.db'),
        join(paths.data, 'second-logs'),
        {
          lockPath: join(paths.run, 'second.lock'),
        },
      );
      try {
        assert.equal(reimport.importDirectory(exported), 2);
        assert.deepEqual(reimport.read(), [decision, outcome]);
      } finally {
        reimport.close();
      }
      assert.equal(
        readFileSync(join(paths.data, 'second.db')).subarray(0, 16).toString(),
        'SQLite format 3\0',
      );
    } finally {
      log.close();
    }
  });

  it('imports the existing daily log the first time SQLite is selected', async () => {
    const paths = tempPaths();
    const legacy = new ShadowLog(paths.logs);
    const record = makeShadowRecord('auto-import');
    legacy.append(record);
    const first = await openLogStore(paths, 'sqlite');
    try {
      assert.deepEqual(first.read(), [record]);
    } finally {
      close(first);
    }
    const second = await openLogStore(paths, 'sqlite');
    try {
      assert.deepEqual(second.read(), [record]);
    } finally {
      close(second);
    }
  });

  it('reimports changed files and distinct files with the same basename', async () => {
    const paths = tempPaths();
    const firstSource = join(paths.data, 'first-source');
    const secondSource = join(paths.data, 'second-source');
    mkdirSync(firstSource, { recursive: true });
    mkdirSync(secondSource, { recursive: true });
    const filename = 'decisions-2026-11-10.jsonl';
    const first = makeShadowRecord('file-first');
    const grown = makeShadowRecord('file-grown');
    const other = makeShadowRecord('other-directory');
    const firstFile = join(firstSource, filename);
    writeFileSync(firstFile, `${JSON.stringify(first)}\n`, { mode: 0o600 });
    const log = await open(paths);
    try {
      assert.equal(log.importDirectory(firstSource), 1);
      writeFileSync(firstFile, `${JSON.stringify(first)}\n${JSON.stringify(grown)}\n`);
      assert.equal(log.importDirectory(firstSource), 2);
      writeFileSync(join(secondSource, filename), `${JSON.stringify(other)}\n`, { mode: 0o600 });
      assert.equal(log.importDirectory(secondSource), 1);
      const ids = log
        .read()
        .map((record) => record.decisionId)
        .toSorted();
      assert.deepEqual(ids, ['file-first', 'file-grown', 'other-directory']);
    } finally {
      log.close();
    }
  });

  it('keeps pending ask decisions available for a later verified outcome', async () => {
    const paths = tempPaths();
    const log = await open(paths);
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
      precedent.noteOutcome({
        kind: 'outcome',
        ts: '2026-11-10T13:00:00.000Z',
        decisionId: decision.decisionId,
        outcome: 'allow',
        source: 'user',
        verified: true,
      });
      assert.deepEqual(precedent.tally('pending-key'), { allows: 1, denies: 0 });
    } finally {
      log.close();
    }
  });

  it('retention removes old orphan outcomes and usage records', async () => {
    const log = await open(tempPaths());
    try {
      log.append({
        kind: 'outcome',
        ts: '2026-08-12T12:00:00.000Z',
        decisionId: 'missing-outcome',
        outcome: 'allow',
        source: 'user',
        verified: true,
      });
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

  it('uses incremental auto-vacuum on new databases and migrates existing databases', async () => {
    const paths = tempPaths();
    const fresh = await open(paths);
    fresh.close();
    assert.equal(await autoVacuumMode(join(paths.data, 'decider.db')), 2);

    const legacyPath = join(paths.data, 'legacy.db');
    const sqlite = await import('node:sqlite');
    const legacy = new sqlite.DatabaseSync(legacyPath, { allowExtension: false });
    legacy.exec('CREATE TABLE legacy(value TEXT)');
    assert.equal(Number(legacy.prepare('PRAGMA auto_vacuum').get()?.['auto_vacuum']), 0);
    legacy.close();
    const migrated = await SqliteLog.open(legacyPath, paths.logs, {
      lockPath: join(paths.run, 'legacy.lock'),
    });
    migrated.close();
    assert.equal(await autoVacuumMode(legacyPath), 2);
  });

  it('returns outcomes in append sequence even if timestamps move backwards', async () => {
    const log = await open(tempPaths());
    try {
      log.append({
        kind: 'outcome',
        ts: '2026-11-10T12:00:00.000Z',
        decisionId: 'same',
        outcome: 'deny',
        source: 'user',
        verified: true,
      });
      log.append({
        kind: 'outcome',
        ts: '2026-11-09T12:00:00.000Z',
        decisionId: 'same',
        outcome: 'allow',
        source: 'user',
        verified: true,
      });
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

  it('falls back to JSONL with a single warning when SQLite cannot load', async () => {
    const paths = tempPaths();
    const warnings: string[] = [];
    const store = await openLogStore(paths, 'sqlite', {
      warn: (message) => warnings.push(message),
      openSqlite: async () => {
        throw new SqliteUnavailableError('simulated module import failure');
      },
    });
    const again = await openLogStore(paths, 'sqlite', {
      warn: (message) => warnings.push(message),
      openSqlite: async () => {
        throw new SqliteUnavailableError('simulated module import failure');
      },
    });
    assert.ok(store instanceof ShadowLog);
    assert.ok(again instanceof ShadowLog);
    assert.equal(warnings.length, 1);
    close(store);
    close(again);
  });
});

async function autoVacuumMode(file: string): Promise<number> {
  const sqlite = await import('node:sqlite');
  const database = new sqlite.DatabaseSync(file, {
    allowExtension: false,
    readOnly: true,
  });
  try {
    return Number(database.prepare('PRAGMA auto_vacuum').get()?.['auto_vacuum']);
  } finally {
    database.close();
  }
}
