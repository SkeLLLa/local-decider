import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  type PathLike,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ensureControlToken, ensureReportToken, readControlToken } from '../src/report-token.ts';
import { tempPaths } from './helpers.ts';

function tokenFiles(paths: ReturnType<typeof tempPaths>): string[] {
  return readdirSync(paths.config).filter((file) => file.endsWith('.tmp'));
}

function createInChild(source: string, config: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const m = await import(process.argv[1]); console.log(m.ensureControlToken({config: process.argv[2]}));',
        source,
        config,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (error += chunk));
    const timer = setTimeout(() => child.kill(), 10_000);
    child.once('error', (reason) => {
      clearTimeout(timer);
      reject(reason);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`token creator exited ${String(code)}: ${error}`));
      else resolve(output.trim());
    });
  });
}

describe('local token files', () => {
  it('creates distinct private control and report tokens once', () => {
    const paths = tempPaths();
    const report = ensureReportToken(paths);
    const control = ensureControlToken(paths);
    assert.match(report, /^[A-Za-z0-9_-]{43}$/);
    assert.match(control, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(control, report);
    assert.equal(ensureReportToken(paths), report);
    assert.equal(ensureControlToken(paths), control);
    assert.equal(readFileSync(join(paths.config, 'control-token'), 'utf8'), control);
    assert.equal(statSync(join(paths.config, 'control-token')).mode & 0o777, 0o600);
    assert.deepEqual(tokenFiles(paths), []);
  });

  it('falls back to exclusive creation when hard links are unsupported', (t) => {
    const paths = tempPaths();
    t.mock.method(fs, 'linkSync', () => {
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    });
    const token = ensureControlToken(paths);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readFileSync(join(paths.config, 'control-token'), 'utf8'), token);
    assert.equal(statSync(join(paths.config, 'control-token')).mode & 0o777, 0o600);
    assert.deepEqual(tokenFiles(paths), []);
  });

  it('reads a concurrent winner if exclusive fallback creation gets EEXIST', (t) => {
    const paths = tempPaths();
    const winner = 'W'.repeat(43);
    t.mock.method(fs, 'linkSync', (_temp: PathLike, file: PathLike) => {
      writeFileSync(file, winner, { flag: 'wx', mode: 0o600 });
      throw Object.assign(new Error('unsupported'), { code: 'EPERM' });
    });
    assert.equal(ensureControlToken(paths), winner);
    assert.equal(readFileSync(join(paths.config, 'control-token'), 'utf8'), winner);
    assert.deepEqual(tokenFiles(paths), []);
  });

  it('refuses empty and truncated token files without revealing their content', () => {
    for (const [filename, content] of [
      ['control-token', ''],
      ['control-token', 'TRUNCATEDsentinel'],
      ['report-token', ''],
    ] as const) {
      const paths = tempPaths();
      const file = join(paths.config, filename);
      mkdirSync(paths.config, { recursive: true });
      writeFileSync(file, content, { mode: 0o600 });
      const ensure = filename === 'report-token' ? ensureReportToken : ensureControlToken;
      assert.throws(ensure.bind(undefined, paths), (error: Error) => {
        assert.match(error.message, /not a valid/);
        assert.match(error.message, new RegExp(filename));
        assert.equal(error.message.includes('TRUNCATEDsentinel'), false);
        return true;
      });
    }
  });

  it(
    'refuses token files readable by other users on non-Windows systems',
    { skip: process.platform === 'win32' },
    () => {
      const paths = tempPaths();
      mkdirSync(paths.config, { recursive: true });
      const file = join(paths.config, 'control-token');
      writeFileSync(file, 'A'.repeat(43), { mode: 0o600 });
      chmodSync(file, 0o644);
      assert.throws(() => ensureControlToken(paths), /chmod 600/);
    },
  );

  it('publishes one complete token when multiple creators race', async () => {
    const paths = tempPaths();
    const source = new URL('../src/report-token.ts', import.meta.url).href;
    const values = await Promise.all(
      Array.from({ length: 8 }, () => createInChild(source, paths.config)),
    );
    const winner = values[0];
    assert.ok(winner !== undefined);
    assert.ok(values.every((value) => /^[A-Za-z0-9_-]{43}$/.test(value)));
    assert.ok(values.every((value) => value === winner));
    assert.equal(readFileSync(join(paths.config, 'control-token'), 'utf8'), winner);
    assert.deepEqual(tokenFiles(paths), []);
  });

  it('reads only a valid existing control token and never creates the file', () => {
    const paths = tempPaths();
    const file = join(paths.config, 'control-token');
    assert.equal(readControlToken(paths), undefined);
    assert.equal(existsSync(file), false);
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(file, '');
    assert.equal(readControlToken(paths), undefined);
    writeFileSync(file, 'truncated');
    assert.equal(readControlToken(paths), undefined);
    const token = 'A'.repeat(43);
    writeFileSync(file, token);
    assert.equal(readControlToken(paths), token);
  });
});
