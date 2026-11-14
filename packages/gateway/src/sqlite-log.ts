import type {
  LogRecord,
  OutcomeRecord,
  ShadowRecord,
  UsageRecord,
} from '@ziptie-soft/local-decider-core';
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { LogStore } from './log-store.ts';
import { ALLOW_VETO_REPLAY_MS } from './outcome-labels.ts';
import type { Paths } from './paths.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

type SqlValue = null | number | bigint | string | NodeJS.ArrayBufferView;
type Row = Record<string, SqlValue>;

interface Statement {
  run(...values: SqlValue[]): { changes: number | bigint };
  all(...values: SqlValue[]): Row[];
  get(...values: SqlValue[]): Row | undefined;
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

interface DatabaseOptions {
  readonly allowExtension: false;
  readonly readOnly?: boolean;
  readonly timeout?: number;
}

type DatabaseConstructor = new (path: string, options: DatabaseOptions) => Database;

interface DatabaseModule {
  readonly Database?: DatabaseConstructor;
  readonly DatabaseSync?: DatabaseConstructor;
}

interface Lock {
  readonly path: string;
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
}

export interface OpenLogOptions {
  readonly readOnly?: boolean;
  /** Writers hold this pid lock file so a second gateway cannot open the same database. */
  readonly lockPath?: string;
}

/** The single durable store, backed by `node:sqlite`. */
export class SqliteLog implements LogStore {
  readonly #database: Database;
  readonly #lock: Lock | undefined;
  readonly #statements = new Map<string, Statement>();
  #closed = false;

  constructor(database: Database, lock?: Lock) {
    this.#database = database;
    this.#lock = lock;
  }

  /** Synchronous: throws a clear error when `node:sqlite` is unavailable. */
  static open(file: string, options: OpenLogOptions = {}): SqliteLog {
    ensureSupportedNode();
    return openDatabase(loadDatabase(), file, options);
  }

  append(record: LogRecord): void {
    try {
      if (record.kind === 'decision') {
        this.#insertDecision(record);
      } else if (record.kind === 'outcome') {
        this.#insertOutcome(record);
      } else {
        this.#insertUsage(record);
      }
    } catch (error) {
      // A storage problem must not turn a decision into an enforcement failure.
      console.error(`sqlite log: ${errorMessage(error)}`);
    }
  }

  read(): LogRecord[] {
    return this.#readRows(undefined);
  }

  readRecent(maxAgeDays: number, now = Date.now()): LogRecord[] {
    const from = utcDateStart(now - maxAgeDays * DAY_MS);
    return this.#readRows(from);
  }

  /**
   * Startup query for precedent (ADR-0006 addendum): escalated decisions with all their verified
   * outcomes (so a neutral outcome's correction replays); recent keyed auto-allows, with or
   * without outcomes (so a first veto after a restart lands); and older keyed auto-allows that
   * already have a verified veto. Each decision precedes its outcomes in `seq` order.
   */
  readVerifiedPrecedent(maxAgeDays: number, now = Date.now()): LogRecord[] {
    const from = utcDateStart(now - maxAgeDays * DAY_MS);
    const recent = Math.max(from, now - ALLOW_VETO_REPLAY_MS);
    const rows = this.#statement(
      `SELECT d.*, o.seq AS outcome_seq, o.ts AS outcome_ts, o.outcome, o.source, o.verified
       FROM decision d
       LEFT JOIN outcome o
         ON o.decision_id = d.id AND o.verified = 1 AND o.source <> 'unverified'
       WHERE d.action = 'ask' AND d.precedent_key IS NOT NULL AND d.ts >= ?
       UNION ALL
       SELECT d.*, o.seq AS outcome_seq, o.ts AS outcome_ts, o.outcome, o.source, o.verified
       FROM decision d
       LEFT JOIN outcome o
         ON o.decision_id = d.id AND o.verified = 1 AND o.source <> 'unverified'
       WHERE d.action = 'allow' AND d.precedent_key IS NOT NULL AND d.ts >= ?
       UNION ALL
       SELECT d.*, o.seq AS outcome_seq, o.ts AS outcome_ts, o.outcome, o.source, o.verified
       FROM decision d
       JOIN outcome o
         ON o.decision_id = d.id AND o.verified = 1 AND o.source <> 'unverified'
       WHERE d.action = 'allow' AND d.precedent_key IS NOT NULL AND d.ts >= ? AND d.ts < ?
         AND d.id IN (
           SELECT v.decision_id FROM outcome v
           WHERE v.verified = 1 AND v.source <> 'unverified'
             AND v.outcome IN ('deny', 'unsafe') AND v.ts >= ?
         )
       ORDER BY ts, id, outcome_seq`,
    ).all(from, recent, from, recent, from);
    return precedentRecords(rows);
  }

  prune(retainDays: number, now = Date.now()): number {
    const cutoff = utcDateStart(now - retainDays * DAY_MS);
    const removeUsage = this.#statement(
      `DELETE FROM usage WHERE decision_id IN (SELECT id FROM decision WHERE ts < ?)
       OR (usage.ts < ? AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = usage.decision_id
       ))`,
    );
    const removeOutcomes = this.#statement(
      `DELETE FROM outcome WHERE decision_id IN (SELECT id FROM decision WHERE ts < ?)
       OR (outcome.ts < ? AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = outcome.decision_id
       ))`,
    );
    const removeDecisions = this.#statement('DELETE FROM decision WHERE ts < ?');
    this.#database.exec('BEGIN IMMEDIATE');
    let deleted: number;
    try {
      removeUsage.run(cutoff, cutoff);
      removeOutcomes.run(cutoff, cutoff);
      deleted = Number(removeDecisions.run(cutoff).changes);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    // After COMMIT: a vacuum failure must not reach the ROLLBACK above.
    this.#database.exec('PRAGMA incremental_vacuum');
    return deleted;
  }

  /** Export records as daily `decisions-YYYY-MM-DD.jsonl` files, the portability format. */
  exportDirectory(destination: string, since?: string): void {
    const records = this.read().filter((record) => since === undefined || record.ts >= since);
    const grouped = new Map<string, string[]>();
    for (const record of records) {
      const date = record.ts.slice(0, 10);
      const lines = grouped.get(date) ?? [];
      lines.push(JSON.stringify(record));
      grouped.set(date, lines);
    }
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const [date, lines] of grouped) {
      const output = join(destination, `decisions-${date}.jsonl`);
      writeFileSync(output, `${lines.join('\n')}\n`, { mode: 0o600 });
      chmodSync(output, 0o600);
    }
  }

  /** Copy a consistent snapshot with SQLite's online VACUUM INTO operation. */
  backup(destination: string): void {
    const directory = mkdtempSync(join(dirname(destination), `.${basename(destination)}-tmp-`));
    chmodSync(directory, 0o700);
    const temporary = join(directory, 'snapshot.db');
    try {
      const escaped = temporary.replaceAll("'", "''");
      this.#database.exec(`VACUUM INTO '${escaped}'`);
      chmodSync(temporary, 0o600);
      linkSync(temporary, destination);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#statements.clear();
    try {
      this.#database.close();
    } finally {
      releaseLock(this.#lock);
    }
  }

  /** Each distinct SQL text is prepared once and reused. */
  #statement(sql: string): Statement {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  #readRows(from: number | undefined): LogRecord[] {
    const predicate = from === undefined ? '' : ' WHERE ts >= ?';
    const args = from === undefined ? [] : [from];
    const decisions = this.#statement(`SELECT * FROM decision${predicate} ORDER BY ts`)
      .all(...args)
      .map(decisionRecord);
    // Stats folds outcomes in record order; seq preserves latest-appended semantics if clocks move.
    const outcomes = this.#statement(`SELECT * FROM outcome${predicate} ORDER BY seq`)
      .all(...args)
      .map(outcomeRecord);
    const usage = this.#statement(`SELECT * FROM usage${predicate} ORDER BY ts, seq`)
      .all(...args)
      .map(usageRecord);
    return [...decisions, ...outcomes, ...usage];
  }

  #insertDecision(record: ShadowRecord): void {
    const extras = record as ShadowRecord & {
      readonly templateKey?: string;
      readonly queueMs?: number;
      readonly engineMs?: number;
    };
    this.#statement(
      `INSERT INTO decision (
        id, ts, policy, variant, mode, scope, harness, session_id, call_id,
        permission_mode, subagent, input_hash, precedent_key, template_key,
        state_tokens, action, enforced, engine, model, latency_ms, queue_ms,
        engine_ms, error, power, requested_model, routed_model, answers
      ) VALUES (${Array.from({ length: 27 }, () => '?').join(', ')})`,
    ).run(
      record.decisionId,
      epoch(record.ts),
      record.policy,
      nullable(record.variant),
      record.mode,
      nullable(record.scope),
      record.harness,
      nullable(record.sessionId),
      nullable(record.callId),
      nullable(record.permissionMode),
      nullableBoolean(record.subagent),
      record.inputHash,
      nullable(record.precedentKey),
      nullable(extras.templateKey),
      nullable(record.stateTokens),
      record.action,
      record.enforced ? 1 : 0,
      record.engine,
      record.model,
      record.latencyMs,
      nullable(extras.queueMs),
      nullable(extras.engineMs),
      nullable(record.error),
      null,
      nullable(record.requestedModel),
      nullable(record.routedModel),
      JSON.stringify(record.answers),
    );
  }

  #insertOutcome(record: OutcomeRecord): void {
    this.#statement(
      `INSERT INTO outcome (decision_id, ts, outcome, source, verified)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      record.decisionId,
      epoch(record.ts),
      record.outcome,
      record.source,
      record.verified === true ? 1 : 0,
    );
  }

  #insertUsage(record: UsageRecord): void {
    this.#statement(
      `INSERT INTO usage (
        decision_id, ts, turn_id, model, input_tokens, cached_input_tokens,
        output_tokens, cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.decisionId,
      epoch(record.ts),
      nullable(record.turnId),
      nullable(record.model),
      record.inputTokens,
      record.cachedInputTokens,
      record.outputTokens,
      nullable(record.costUsd),
    );
  }
}

/** Open the store under the data directory; writers take the pid lock. */
export function openLogStore(
  paths: Paths,
  options: { readonly readOnly?: boolean } = {},
): SqliteLog {
  const readOnly = options.readOnly === true;
  return SqliteLog.open(join(paths.data, 'decider.db'), {
    readOnly,
    ...(readOnly ? {} : { lockPath: join(paths.run, 'db.lock') }),
  });
}

function openDatabase(Db: DatabaseConstructor, file: string, options: OpenLogOptions): SqliteLog {
  const readOnly = options.readOnly === true;
  let lock: Lock | undefined;
  let database: Database | undefined;
  try {
    if (readOnly) {
      if (!existsSync(file)) {
        throw new Error(`SQLite log does not exist: ${file}`);
      }
    } else {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      chmodSync(dirname(file), 0o700);
      lock = options.lockPath === undefined ? undefined : acquireLock(options.lockPath);
      createPrivateFile(file);
    }
    database = new Db(file, { allowExtension: false, readOnly, timeout: 2000 });
    if (!readOnly) {
      configureDatabase(database);
      chmodSync(file, 0o600);
    }
    return new SqliteLog(database, lock);
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the startup failure and still release the process lock.
    }
    releaseLock(lock);
    throw error;
  }
}

function configureDatabase(database: Database): void {
  // auto_vacuum only takes effect before the first table exists.
  database.exec('PRAGMA auto_vacuum=INCREMENTAL');
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=NORMAL');
  database.exec('PRAGMA busy_timeout=2000');
  migrate(database);
  ensureIncrementalVacuum(database);
}

/**
 * `auto_vacuum` only applies to a database created after it was set. A file that already had
 * tables (created elsewhere, or before the pragma) is rebuilt once so pruning can reclaim pages.
 */
function ensureIncrementalVacuum(database: Database): void {
  const mode = Number(database.prepare('PRAGMA auto_vacuum').get()?.['auto_vacuum'] ?? 0);
  if (mode !== 2) {
    database.exec('VACUUM');
  }
}

/** Apply pending steps from `PRAGMA user_version`; each step and its version bump is atomic. */
function migrate(database: Database): void {
  const current = Number(database.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
  if (current > MIGRATIONS.length) {
    throw new Error(
      `SQLite log schema version ${String(current)} is newer than this build supports (${String(MIGRATIONS.length)})`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(MIGRATIONS[version] as string);
      database.exec(`PRAGMA user_version = ${String(version + 1)}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Append only: step N takes a database from `user_version` N to N + 1. */
const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE decision(
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, policy TEXT NOT NULL, variant TEXT,
  mode TEXT NOT NULL, scope TEXT, harness TEXT NOT NULL, session_id TEXT, call_id TEXT,
  permission_mode TEXT, subagent INTEGER, input_hash TEXT NOT NULL,
  precedent_key TEXT, template_key TEXT, state_tokens INTEGER,
  action TEXT NOT NULL, enforced INTEGER NOT NULL, engine TEXT, model TEXT,
  latency_ms INTEGER, queue_ms INTEGER, engine_ms INTEGER, error TEXT, power TEXT,
  requested_model TEXT, routed_model TEXT, answers TEXT NOT NULL) STRICT;
CREATE INDEX decision_ts ON decision(ts);
CREATE INDEX decision_policy_ts ON decision(policy, ts);
CREATE INDEX decision_scope_ts ON decision(scope, ts) WHERE scope IS NOT NULL;
CREATE INDEX decision_prec ON decision(precedent_key, ts)
  WHERE action = 'ask' AND precedent_key IS NOT NULL;
CREATE INDEX decision_tmpl ON decision(template_key, ts)
  WHERE action = 'ask' AND template_key IS NOT NULL;
CREATE TABLE outcome(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL,
  outcome TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL) STRICT;
CREATE INDEX outcome_ts ON outcome(ts);
CREATE INDEX outcome_decision ON outcome(decision_id, seq);
CREATE TABLE usage(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL, turn_id TEXT,
  model TEXT, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cost_usd REAL) STRICT;
CREATE INDEX usage_ts ON usage(ts);
CREATE INDEX usage_decision ON usage(decision_id);
`,
  'UPDATE decision SET precedent_key = NULL;',
];

function loadDatabase(): DatabaseConstructor {
  const sqlite = process.getBuiltinModule('node:sqlite') as DatabaseModule | undefined;
  const Db = sqlite?.Database ?? sqlite?.DatabaseSync;
  if (Db === undefined) {
    throw new Error(
      'node:sqlite is unavailable in this runtime; local-decider needs Node >= 24.15',
    );
  }
  return Db;
}

function ensureSupportedNode(): void {
  const [majorText, minorText] = process.versions.node.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new Error(
      `Node ${process.versions.node} is below the SQLite minimum 24.15; local-decider needs Node >= 24.15`,
    );
  }
}

function createPrivateFile(file: string): void {
  const fd = openSync(file, 'a', 0o600);
  closeSync(fd);
  chmodSync(file, 0o600);
}

function acquireLock(path: string): Lock {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, `${String(process.pid)}\n`);
        const { dev, ino } = fstatSync(fd);
        return { path, fd, dev, ino };
      } catch (error) {
        closeSync(fd);
        unlinkSync(path);
        throw error;
      }
    } catch (error) {
      if (!isExistsError(error) || !removeStaleLock(path)) {
        throw new Error(`SQLite database is locked by another writer (${path})`, { cause: error });
      }
    }
  }
  throw new Error(`SQLite database is locked by another writer (${path})`);
}

function removeStaleLock(path: string): boolean {
  try {
    const beforeStat = lstatSync(path);
    const before = readFileSync(path, 'utf8');
    const pid = Number.parseInt(before, 10);
    if (!Number.isInteger(pid) || processIsAlive(pid)) {
      return false;
    }
    const afterStat = lstatSync(path);
    const after = readFileSync(path, 'utf8');
    if (before !== after || beforeStat.dev !== afterStat.dev || beforeStat.ino !== afterStat.ino) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releaseLock(lock: Lock | undefined): void {
  if (lock === undefined) {
    return;
  }
  try {
    closeSync(lock.fd);
  } catch {
    // The descriptor may already have been closed during a failed open.
  }
  try {
    const pathStat = lstatSync(lock.path);
    if (pathStat.dev === lock.dev && pathStat.ino === lock.ino) {
      unlinkSync(lock.path);
    }
  } catch {
    // A replaced or removed lock belongs to another process and is left alone.
  }
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function nullable<T extends SqlValue>(value: T | undefined): T | null {
  return value ?? null;
}

function nullableBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}

function epoch(ts: string): number {
  const value = Date.parse(ts);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid log timestamp: ${ts}`);
  }
  return value;
}

function utcDateStart(timeMs: number): number {
  return Date.parse(new Date(timeMs).toISOString().slice(0, 10));
}

function isoTime(value: SqlValue | undefined): string {
  return new Date(Number(value)).toISOString();
}

function text(value: SqlValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function optionalText(value: SqlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: SqlValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

type DecisionExtras = Partial<ShadowRecord> & {
  readonly templateKey?: string;
  readonly queueMs?: number;
  readonly engineMs?: number;
};

function decisionRecord(row: Row): ShadowRecord {
  return {
    kind: 'decision',
    ts: isoTime(row['ts']),
    decisionId: text(row['id']),
    policy: text(row['policy']),
    mode: text(row['mode']) as ShadowRecord['mode'],
    harness: text(row['harness']) as ShadowRecord['harness'],
    inputHash: text(row['input_hash']),
    answers: JSON.parse(text(row['answers'])) as ShadowRecord['answers'],
    action: text(row['action']),
    enforced: Number(row['enforced']) === 1,
    engine: text(row['engine']),
    model: text(row['model']),
    latencyMs: Number(row['latency_ms'] ?? 0),
    ...decisionContext(row),
    ...decisionMetrics(row),
  };
}

function decisionContext(row: Row): DecisionExtras {
  const variant = optionalText(row['variant']);
  const scope = optionalText(row['scope']);
  const sessionId = optionalText(row['session_id']);
  const callId = optionalText(row['call_id']);
  const permissionMode = optionalText(row['permission_mode']);
  return {
    ...(variant === undefined ? {} : { variant }),
    ...(scope === undefined ? {} : { scope: scope as NonNullable<ShadowRecord['scope']> }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(callId === undefined ? {} : { callId }),
    ...(permissionMode === undefined
      ? {}
      : { permissionMode: permissionMode as NonNullable<ShadowRecord['permissionMode']> }),
    ...(row['subagent'] === null || row['subagent'] === undefined
      ? {}
      : { subagent: Number(row['subagent']) === 1 }),
  };
}

function decisionMetrics(row: Row): DecisionExtras {
  const precedentKey = optionalText(row['precedent_key']);
  const stateTokens = optionalNumber(row['state_tokens']);
  const error = optionalText(row['error']);
  const requestedModel = optionalText(row['requested_model']);
  const routedModel = optionalText(row['routed_model']);
  const templateKey = optionalText(row['template_key']);
  const queueMs = optionalNumber(row['queue_ms']);
  const engineMs = optionalNumber(row['engine_ms']);
  return {
    ...(precedentKey === undefined ? {} : { precedentKey }),
    ...(stateTokens === undefined ? {} : { stateTokens }),
    ...(error === undefined ? {} : { error }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    ...(routedModel === undefined ? {} : { routedModel }),
    ...(templateKey === undefined ? {} : { templateKey }),
    ...(queueMs === undefined ? {} : { queueMs }),
    ...(engineMs === undefined ? {} : { engineMs }),
  };
}

function outcomeRecord(row: Row): OutcomeRecord {
  return {
    kind: 'outcome',
    ts: isoTime(row['outcome_ts'] ?? row['ts']),
    decisionId: text(row['decision_id'] ?? row['id']),
    outcome: text(row['outcome']),
    source: text(row['source']) as OutcomeRecord['source'],
    verified: Number(row['verified']) === 1,
  };
}

/** One decision record per decision id, then its outcome rows (rows are grouped by id). */
function precedentRecords(rows: readonly Row[]): LogRecord[] {
  const records: LogRecord[] = [];
  let last: string | undefined;
  for (const row of rows) {
    const id = text(row['id']);
    if (id !== last) {
      records.push(decisionRecord(row));
      last = id;
    }
    if (row['outcome_seq'] !== null && row['outcome_seq'] !== undefined) {
      records.push(outcomeRecord(row));
    }
  }
  return records;
}

function usageRecord(row: Row): UsageRecord {
  const turnId = optionalText(row['turn_id']);
  const model = optionalText(row['model']);
  const costUsd = optionalNumber(row['cost_usd']);
  return {
    kind: 'usage',
    ts: isoTime(row['ts']),
    decisionId: text(row['decision_id']),
    inputTokens: Number(row['input_tokens']),
    cachedInputTokens: Number(row['cached_input_tokens']),
    outputTokens: Number(row['output_tokens']),
    ...(turnId === undefined ? {} : { turnId }),
    ...(model === undefined ? {} : { model }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
