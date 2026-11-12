import type { LogRecord } from '@ziptie-soft/local-decider-core';

/** Durable decision, outcome and usage storage; precedent and calibration are rebuilt from it. */
export interface LogStore {
  append(record: LogRecord): void;
  read(): LogRecord[];
  readRecent(maxAgeDays: number, now?: number): LogRecord[];
  /** Precedent evidence: keyed ask decisions and recent keyed auto-allows, with verified outcomes. */
  readVerifiedPrecedent(maxAgeDays: number, now?: number): LogRecord[];
  prune(retainDays: number, now?: number): number;
  close(): void;
}
