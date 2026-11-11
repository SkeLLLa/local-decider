import type { LogRecord } from '@local-decider/core';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

const FILE_PATTERN = /^decisions-\d{4}-\d{2}-\d{2}\.jsonl$/;
const KINDS = new Set<string>(['decision', 'outcome', 'usage']);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Append-only decision, outcome and usage storage. */
export interface LogStore {
  append(record: LogRecord): void;
  read(): LogRecord[];
  readRecent(maxAgeDays: number, now?: number): LogRecord[];
  prune(retainDays: number, now?: number): number;
  readonly dir: string;
}

/** Append-only JSONL, one file per UTC day. Holds hashes, answers, actions and token counts; never state text. */
export class ShadowLog implements LogStore {
  readonly #dir: string;
  readonly #checkedFiles = new Set<string>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  append(record: LogRecord): void {
    try {
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const file = join(this.#dir, `decisions-${record.ts.slice(0, 10)}.jsonl`);
      repairTornLine(file, this.#checkedFiles);
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      // Logging must never fail a decision.
      console.error(`shadow log: ${(error as Error).message}`);
    }
  }

  /** Every record, oldest file first. Malformed lines are skipped. */
  read(): LogRecord[] {
    return this.#readFrom();
  }

  /** Recent records only, with exact timestamp filtering left to their consumers. */
  readRecent(maxAgeDays: number, now = Date.now()): LogRecord[] {
    const from = new Date(now - maxAgeDays * DAY_MS).toISOString().slice(0, 10);
    return this.#readFrom(from);
  }

  /** Delete dated decision logs whose UTC date falls before the retention boundary. */
  prune(retainDays: number, now = Date.now()): number {
    return pruneFiles(this.#dir, retainDays, now);
  }

  #readFrom(from?: string): LogRecord[] {
    if (!existsSync(this.#dir)) {
      return [];
    }
    const records: LogRecord[] = [];
    for (const name of readdirSync(this.#dir)
      .filter((n) => FILE_PATTERN.test(n))
      .filter((n) => from === undefined || n.slice('decisions-'.length, -'.jsonl'.length) >= from)
      .toSorted()) {
      for (const line of readFileSync(join(this.#dir, name), 'utf8').split('\n')) {
        const record = parseLogLine(line);
        if (record !== undefined) {
          records.push(record);
        }
      }
    }
    return records;
  }
}

function pruneFiles(dir: string, retainDays: number, now: number): number {
  if (!existsSync(dir)) {
    return 0;
  }
  const cutoff = new Date(now - retainDays * DAY_MS).toISOString().slice(0, 10);
  let deleted = 0;
  for (const name of readdirSync(dir)) {
    const date = datedLog(name);
    if (date !== undefined && date < cutoff) {
      unlinkSync(join(dir, name));
      deleted += 1;
    }
  }
  return deleted;
}

function repairTornLine(file: string, checkedFiles: Set<string>): void {
  if (checkedFiles.has(file)) {
    return;
  }
  if (!existsSync(file)) {
    checkedFiles.add(file);
    return;
  }
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size > 0) {
      appendMissingNewline(file, fd, size);
    }
    checkedFiles.add(file);
  } finally {
    closeSync(fd);
  }
}

function appendMissingNewline(file: string, fd: number, size: number): void {
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  if (last[0] !== 0x0a) {
    appendFileSync(file, '\n');
  }
}

function datedLog(name: string): string | undefined {
  return FILE_PATTERN.test(name) ? name.slice('decisions-'.length, -'.jsonl'.length) : undefined;
}

export function parseLogLine(line: string): LogRecord | undefined {
  if (line.trim() === '') {
    return undefined;
  }
  try {
    const value = JSON.parse(line) as { kind?: unknown };
    return typeof value.kind === 'string' && KINDS.has(value.kind)
      ? (value as LogRecord)
      : undefined;
  } catch {
    return undefined;
  }
}
