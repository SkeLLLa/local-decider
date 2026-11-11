import type {
  LogRecord,
  OutcomeRecord,
  ShadowRecord,
  UsageRecord,
} from '@ziptie-soft/local-decider-core';
import { createHash } from 'node:crypto';
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
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Paths } from './paths.ts';
import { parseLogLine, ShadowLog, type LogStore } from './shadow.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const JSONL_FILE = /^decisions-\d{4}-\d{2}-\d{2}\.jsonl$/;
const SCHEMA_VERSION = '1';
let fallbackWarned = false;

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

interface DatabaseModule {
  readonly Database?: new (path: string, options: DatabaseOptions) => Database;
  readonly DatabaseSync?: new (path: string, options: DatabaseOptions) => Database;
}

interface Lock {
  readonly path: string;
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
}

export interface OpenLogOptions {
  readonly readOnly?: boolean;
  readonly warn?: (message: string) => void;
  readonly autoImport?: boolean;
  /** Tests can model a runtime where the built-in module cannot be loaded. */
  readonly openSqlite?: typeof SqliteLog.open;
}

/** SQLite JSONL-compatible backend. The directory is the legacy JSONL import/export directory. */
export class SqliteLog implements LogStore {
  readonly #database: Database;
  readonly #dir: string;
  readonly #lock: Lock | undefined;
  #closed = false;

  constructor(database: Database, dir: string, lock?: Lock) {
    this.#database = database;
    this.#dir = dir;
    this.#lock = lock;
  }

  static async open(
    file: string,
    dir: string,
    options: { readonly readOnly?: boolean; readonly lockPath?: string } = {},
  ): Promise<SqliteLog> {
    ensureSupportedNode();
    const sqlite = await importSqlite();
    const Db = sqlite.Database ?? sqlite.DatabaseSync;
    if (Db === undefined) {
      throw new SqliteUnavailableError('node:sqlite exports no Database constructor');
    }
    return openDatabase(Db, file, dir, options);
  }

  get dir(): string {
    return this.#dir;
  }

  append(record: LogRecord): void {
    try {
      this.#insert(record, false);
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

  /** Small startup query for precedent: only the first verified outcome can teach a key. */
  readVerifiedPrecedent(maxAgeDays: number, now = Date.now()): LogRecord[] {
    const from = utcDateStart(now - maxAgeDays * DAY_MS);
    const rows = this.#database
      .prepare(
        `SELECT d.*, o.seq AS outcome_seq, o.ts AS outcome_ts, o.outcome, o.source, o.verified
         FROM decision d
         LEFT JOIN outcome o ON o.seq = (
           SELECT MIN(first.seq) FROM outcome first
           WHERE first.decision_id = d.id AND first.verified = 1
         )
         WHERE d.action = 'ask' AND d.precedent_key IS NOT NULL AND d.ts >= ?
         ORDER BY d.ts, d.id`,
      )
      .all(from);
    return rows.flatMap((row) =>
      row['outcome_seq'] === null || row['outcome_seq'] === undefined
        ? [decisionRecord(row)]
        : [decisionRecord(row), outcomeRecord(row)],
    );
  }

  prune(retainDays: number, now = Date.now()): number {
    const cutoff = utcDateStart(now - retainDays * DAY_MS);
    const removeUsage = this.#database.prepare(
      `DELETE FROM usage WHERE decision_id IN (SELECT id FROM decision WHERE ts < ?)
       OR (usage.ts < ? AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = usage.decision_id
       ))`,
    );
    const removeOutcomes = this.#database.prepare(
      `DELETE FROM outcome WHERE decision_id IN (SELECT id FROM decision WHERE ts < ?)
       OR (outcome.ts < ? AND NOT EXISTS (
         SELECT 1 FROM decision d WHERE d.id = outcome.decision_id
       ))`,
    );
    const removeDecisions = this.#database.prepare('DELETE FROM decision WHERE ts < ?');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      removeUsage.run(cutoff, cutoff);
      removeOutcomes.run(cutoff, cutoff);
      const deleted = Number(removeDecisions.run(cutoff).changes);
      this.#database.exec('COMMIT');
      this.#database.exec('PRAGMA incremental_vacuum');
      return deleted;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Import each distinct JSONL content once. The source files are left in place. */
  importDirectory(source: string): number {
    if (!existsSync(source)) {
      return 0;
    }
    let imported = 0;
    const files = readdirSync(source)
      .filter((name) => JSONL_FILE.test(name))
      .toSorted();
    for (const name of files) {
      const content = readFileSync(join(source, name));
      const identity = createHash('sha256').update(content).digest('hex');
      if (this.#isImported(identity)) {
        continue;
      }
      imported += this.#importFile(content, name, identity);
    }
    return imported;
  }

  /** Export records into the established daily JSONL format. */
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
    try {
      this.#database.close();
    } finally {
      releaseLock(this.#lock);
    }
  }

  #readRows(from: number | undefined): LogRecord[] {
    const predicate = from === undefined ? '' : ' WHERE ts >= ?';
    const args = from === undefined ? [] : [from];
    const decisions = this.#database
      .prepare(`SELECT * FROM decision${predicate} ORDER BY ts`)
      .all(...args)
      .map(decisionRecord);
    // Stats folds outcomes in record order; seq preserves latest-appended semantics if clocks move.
    const outcomes = this.#database
      .prepare(`SELECT * FROM outcome${predicate} ORDER BY seq`)
      .all(...args)
      .map(outcomeRecord);
    const usage = this.#database
      .prepare(`SELECT * FROM usage${predicate} ORDER BY ts, seq`)
      .all(...args)
      .map(usageRecord);
    return [...decisions, ...outcomes, ...usage];
  }

  #insert(record: LogRecord, ignore: boolean): void {
    const conflict = ignore ? ' OR IGNORE' : '';
    if (record.kind === 'decision') {
      this.#insertDecision(record, conflict);
    } else if (record.kind === 'outcome') {
      if (ignore && this.#hasOutcome(record)) {
        return;
      }
      this.#insertOutcome(record, conflict);
    } else {
      if (ignore && this.#hasUsage(record)) {
        return;
      }
      this.#insertUsage(record, conflict);
    }
  }

  #hasOutcome(record: OutcomeRecord): boolean {
    return (
      this.#database
        .prepare(
          'SELECT 1 AS present FROM outcome WHERE decision_id = ? AND ts = ? AND outcome = ? AND source = ?',
        )
        .get(record.decisionId, epoch(record.ts), record.outcome, record.source) !== undefined
    );
  }

  #hasUsage(record: UsageRecord): boolean {
    return (
      this.#database
        .prepare('SELECT 1 AS present FROM usage WHERE decision_id = ? AND ts = ? AND turn_id IS ?')
        .get(record.decisionId, epoch(record.ts), nullable(record.turnId)) !== undefined
    );
  }

  #insertDecision(record: ShadowRecord, conflict: string): void {
    const extras = record as ShadowRecord & {
      readonly templateKey?: string;
      readonly queueMs?: number;
      readonly engineMs?: number;
    };
    this.#database
      .prepare(
        `INSERT${conflict} INTO decision (
          id, ts, policy, variant, mode, scope, harness, session_id, call_id,
          permission_mode, subagent, input_hash, precedent_key, template_key,
          state_tokens, action, enforced, engine, model, latency_ms, queue_ms,
          engine_ms, error, power, requested_model, routed_model, answers
        ) VALUES (${Array.from({ length: 27 }, () => '?').join(', ')})`,
      )
      .run(
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

  #insertOutcome(record: OutcomeRecord, conflict: string): void {
    this.#database
      .prepare(
        `INSERT${conflict} INTO outcome (decision_id, ts, outcome, source, verified)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        record.decisionId,
        epoch(record.ts),
        record.outcome,
        record.source,
        record.verified === true ? 1 : 0,
      );
  }

  #insertUsage(record: UsageRecord, conflict: string): void {
    this.#database
      .prepare(
        `INSERT${conflict} INTO usage (
          decision_id, ts, turn_id, model, input_tokens, cached_input_tokens,
          output_tokens, cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  #isImported(identity: string): boolean {
    return (
      this.#database
        .prepare('SELECT 1 AS imported FROM meta WHERE key = ?')
        .get(`import:sha256:${identity}`) !== undefined
    );
  }

  #importFile(content: Buffer, name: string, identity: string): number {
    let count = 0;
    const lines = content.toString('utf8').split('\n');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      for (const line of lines) {
        const record = parseLogLine(line);
        if (record !== undefined) {
          this.#insert(record, true);
          count += 1;
        }
      }
      this.#database
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run(`import:sha256:${identity}`, name);
      this.#database.exec('COMMIT');
      return count;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
}

export class SqliteUnavailableError extends Error {}

/** Select the configured backend and import existing JSONL once when SQLite is first selected. */
export async function openLogStore(
  paths: Paths,
  selection: 'jsonl' | 'sqlite',
  options: OpenLogOptions = {},
): Promise<LogStore> {
  if (selection === 'jsonl') {
    return new ShadowLog(paths.logs);
  }
  try {
    const open =
      options.openSqlite ?? ((file, dir, openOptions) => SqliteLog.open(file, dir, openOptions));
    const log = await open(join(paths.data, 'decider.db'), paths.logs, {
      ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
      ...(options.readOnly === true ? {} : { lockPath: join(paths.run, 'db.lock') }),
    });
    if (options.autoImport !== false && options.readOnly !== true) {
      log.importDirectory(paths.logs);
    }
    return log;
  } catch (error) {
    if (!(error instanceof SqliteUnavailableError)) {
      throw error;
    }
    warnFallback(options.warn, error.message);
    return new ShadowLog(paths.logs);
  }
}

function openDatabase(
  Db: new (path: string, options: DatabaseOptions) => Database,
  file: string,
  dir: string,
  options: { readonly readOnly?: boolean; readonly lockPath?: string },
): SqliteLog {
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
    return new SqliteLog(database, dir, lock);
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
  const previousAutoVacuum = Number(
    database.prepare('PRAGMA auto_vacuum').get()?.['auto_vacuum'] ?? 0,
  );
  const hadTables =
    database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' LIMIT 1")
      .get() !== undefined;
  database.exec('PRAGMA auto_vacuum=INCREMENTAL');
  if (hadTables && previousAutoVacuum !== 2) {
    database.exec('VACUUM');
  }
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=NORMAL');
  database.exec('PRAGMA busy_timeout=2000');
  database.exec(SCHEMA_SQL);
  database
    .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
    .run('schema_version', SCHEMA_VERSION);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decision(
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, policy TEXT NOT NULL, variant TEXT,
  mode TEXT NOT NULL, scope TEXT, harness TEXT NOT NULL, session_id TEXT, call_id TEXT,
  permission_mode TEXT, subagent INTEGER, input_hash TEXT NOT NULL,
  precedent_key TEXT, template_key TEXT, state_tokens INTEGER,
  action TEXT NOT NULL, enforced INTEGER NOT NULL, engine TEXT, model TEXT,
  latency_ms INTEGER, queue_ms INTEGER, engine_ms INTEGER, error TEXT, power TEXT,
  requested_model TEXT, routed_model TEXT, answers TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS decision_policy_ts ON decision(policy, ts);
CREATE INDEX IF NOT EXISTS decision_scope_ts ON decision(scope, ts) WHERE scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS decision_prec ON decision(precedent_key, ts)
  WHERE action = 'ask' AND precedent_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS decision_tmpl ON decision(template_key, ts)
  WHERE action = 'ask' AND template_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS outcome(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL,
  outcome TEXT NOT NULL, source TEXT NOT NULL, verified INTEGER NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS outcome_decision ON outcome(decision_id, seq);
CREATE TABLE IF NOT EXISTS usage(
  seq INTEGER PRIMARY KEY, decision_id TEXT NOT NULL, ts INTEGER NOT NULL, turn_id TEXT,
  model TEXT, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, cost_usd REAL) STRICT;
CREATE INDEX IF NOT EXISTS usage_decision ON usage(decision_id);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

async function importSqlite(): Promise<DatabaseModule> {
  try {
    return await import('node:sqlite');
  } catch (error) {
    throw new SqliteUnavailableError(`node:sqlite is unavailable: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function ensureSupportedNode(): void {
  const [majorText, minorText] = process.versions.node.split('.');
  const major = Number(majorText);
  const minor = Number(minorText);
  if (major < 24 || (major === 24 && minor < 15)) {
    throw new SqliteUnavailableError(
      `Node ${process.versions.node} is below the SQLite minimum 24.15`,
    );
  }
}

function warnFallback(warn: ((message: string) => void) | undefined, reason: string): void {
  if (fallbackWarned) {
    return;
  }
  fallbackWarned = true;
  (warn ?? console.warn)(`SQLite log unavailable; using JSONL shadow log: ${reason}`);
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
