import { randomBytes } from 'node:crypto';
import fs, { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Paths } from './paths.ts';

const REPORT_FILE = 'report-token';
const CONTROL_FILE = 'control-token';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A token as `ensureToken` generates it: 32 random bytes, base64url, no padding. */
function isLocalToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Refuse a token file others can read; Windows mode bits do not reflect ACLs. */
function checkPrivate(file: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${file} is accessible to other users (mode 0${mode.toString(8)}); run chmod 600 ${file}`,
    );
  }
}

/** Read and validate an existing token file; the message never contains its content. */
function readExisting(file: string): string {
  checkPrivate(file);
  const token = readFileSync(file, 'utf8').trim();
  if (!isLocalToken(token)) {
    throw new Error(
      `${file} is not a valid local-decider token; delete it and start the gateway again`,
    );
  }
  return token;
}

/** Publish a fully written token without replacing a concurrent winner; returns the token in effect. */
function publish(file: string, token: string): string {
  const temp = `${file}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    fs.linkSync(temp, file);
    return token;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return readExisting(file);
    if (!linkUnsupported(error)) throw error;
    return publishExclusively(file, token);
  } finally {
    rmSync(temp, { force: true });
  }
}

function publishExclusively(file: string, token: string): string {
  try {
    writeFileSync(file, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return token;
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error;
    return readExisting(file);
  }
}

/** Created at first start, reused afterwards. */
function ensureToken(paths: Paths, name: string): string {
  mkdirSync(paths.config, { recursive: true, mode: 0o700 });
  const file = join(paths.config, name);
  try {
    return readExisting(file);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  return publish(file, randomBytes(32).toString('base64url'));
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function linkUnsupported(error: unknown): boolean {
  return (
    hasCode(error, 'EPERM') ||
    hasCode(error, 'ENOTSUP') ||
    hasCode(error, 'EXDEV') ||
    hasCode(error, 'ENOSYS')
  );
}

/** Create or read the private token used to authenticate outcome reports from Paseo. */
export function ensureReportToken(paths: Paths): string {
  return ensureToken(paths, REPORT_FILE);
}

/** Create or read the private token that guards control and config routes (S4). */
export function ensureControlToken(paths: Paths): string {
  return ensureToken(paths, CONTROL_FILE);
}

/** The control token once the gateway has created it; undefined when missing or malformed. */
export function readControlToken(paths: Paths): string | undefined {
  try {
    const token = readFileSync(join(paths.config, CONTROL_FILE), 'utf8').trim();
    return isLocalToken(token) ? token : undefined;
  } catch {
    return undefined;
  }
}
