import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Paths } from './paths.ts';

const TOKEN_FILE = 'report-token';

/** Create or read the private token used to authenticate outcome reports from Paseo. */
export function ensureReportToken(paths: Paths): string {
  mkdirSync(paths.config, { recursive: true, mode: 0o700 });
  const file = join(paths.config, TOKEN_FILE);
  try {
    return readToken(file);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }

  const token = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return token;
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw error;
    }
    return readToken(file);
  }
}

function readToken(file: string): string {
  return readFileSync(file, 'utf8').trim();
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
