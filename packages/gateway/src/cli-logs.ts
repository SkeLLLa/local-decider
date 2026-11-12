import { parseArgs } from 'node:util';

import type { Paths } from './paths.ts';
import { openLogStore } from './sqlite-log.ts';

/** SQLite backup and JSONL interchange export commands. */
export function logsCommand(paths: Paths, args: readonly string[]): void {
  const [action, ...rest] = args;
  if (action === 'backup') {
    return backup(paths, rest);
  }
  if (action === 'export') {
    return exportLogs(paths, rest);
  }
  throw new Error('usage: local-decider logs backup <file> | export [--since YYYY-MM-DD] <dir>');
}

function backup(paths: Paths, args: readonly string[]): void {
  const destination = required(args[0]);
  const log = openLogStore(paths, { readOnly: true });
  try {
    log.backup(destination);
  } finally {
    log.close();
  }
}

function exportLogs(paths: Paths, args: readonly string[]): void {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { since: { type: 'string' } },
    allowPositionals: true,
  });
  const destination = required(positionals[0]);
  if (values.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }
  const log = openLogStore(paths, { readOnly: true });
  try {
    log.exportDirectory(destination, values.since);
  } finally {
    log.close();
  }
}

function required(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('a file or directory argument is required');
  }
  return value;
}
