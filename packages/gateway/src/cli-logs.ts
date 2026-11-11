import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type { GatewayConfig } from './config.ts';
import type { Paths } from './paths.ts';
import { SqliteLog } from './sqlite-log.ts';

/** SQLite backup, interchange export and idempotent legacy import commands. */
export async function logsCommand(
  paths: Paths,
  config: GatewayConfig,
  args: readonly string[],
): Promise<void> {
  const [action, ...rest] = args;
  if (config.logs.store !== 'sqlite') {
    throw new Error('set logs.store: sqlite in config.yaml before using local-decider logs');
  }
  if (action === 'backup') {
    return backup(paths, rest);
  }
  if (action === 'export') {
    return exportLogs(paths, rest);
  }
  if (action === 'import') {
    return importLogs(paths, rest);
  }
  throw new Error(
    'usage: local-decider logs backup <file> | export [--since YYYY-MM-DD] <dir> | import <dir>',
  );
}

async function backup(paths: Paths, args: readonly string[]): Promise<void> {
  const destination = required(args[0]);
  const log = await openSqlite(paths, true);
  try {
    log.backup(destination);
  } finally {
    log.close();
  }
}

async function exportLogs(paths: Paths, args: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { since: { type: 'string' } },
    allowPositionals: true,
  });
  const destination = required(positionals[0]);
  if (values.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.since)) {
    throw new Error('--since must be YYYY-MM-DD');
  }
  const log = await openSqlite(paths, true);
  try {
    log.exportDirectory(destination, values.since);
  } finally {
    log.close();
  }
}

async function importLogs(paths: Paths, args: readonly string[]): Promise<void> {
  const source = required(args[0]);
  const log = await openSqlite(paths, false);
  try {
    const count = log.importDirectory(source);
    console.log(`imported ${String(count)} records from ${source}`);
  } finally {
    log.close();
  }
}

function openSqlite(paths: Paths, readOnly: boolean): Promise<SqliteLog> {
  return SqliteLog.open(join(paths.data, 'decider.db'), paths.logs, {
    readOnly,
    ...(readOnly ? {} : { lockPath: join(paths.run, 'db.lock') }),
  });
}

function required(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('a file or directory argument is required');
  }
  return value;
}
