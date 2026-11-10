import type { LogRecord } from '@local-decider/core';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE_PATTERN = /^decisions-\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Append-only JSONL, one file per UTC day. Holds hashes, answers and actions; never state text. */
export class ShadowLog {
  readonly #dir: string;

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
      appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      // Logging must never fail a decision.
      console.error(`shadow log: ${(error as Error).message}`);
    }
  }

  /** Every record, oldest file first. Malformed lines are skipped. */
  read(): LogRecord[] {
    if (!existsSync(this.#dir)) {
      return [];
    }
    const records: LogRecord[] = [];
    for (const name of readdirSync(this.#dir)
      .filter((n) => FILE_PATTERN.test(n))
      .toSorted()) {
      for (const line of readFileSync(join(this.#dir, name), 'utf8').split('\n')) {
        const record = parseLine(line);
        if (record !== undefined) {
          records.push(record);
        }
      }
    }
    return records;
  }
}

function parseLine(line: string): LogRecord | undefined {
  if (line.trim() === '') {
    return undefined;
  }
  try {
    const value = JSON.parse(line) as { kind?: unknown };
    return value.kind === 'decision' || value.kind === 'outcome' ? (value as LogRecord) : undefined;
  } catch {
    return undefined;
  }
}
