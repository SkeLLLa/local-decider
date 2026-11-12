import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactDeep, redactSecrets } from '../src/index.ts';

const KIB = 1024;

// Budgets catch quadratic blowups, which cost seconds, not small constant factors. Shared CI
// runners (with coverage on) are 2-4x slower than a dev machine, so give them headroom.
const SLACK = process.env['CI'] ? 4 : 1;
const fitsBudget = (budgetMs: number, runs: number, fn: () => void): boolean =>
  bestOf(runs, fn) <= budgetMs * SLACK;

function bestOf(runs: number, fn: () => void): number {
  for (let i = 0; i < 3; i++) fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const BLOCK = [
  'Run `git commit -m "fix token parsing"` then `pnpm test --filter core`.',
  '{"tool": "Bash", "command": "curl -s https://api.example.com/v1/items?page=2", "max_tokens": 4096}',
  'DB_PASSWORD=hunter22 PGHOST=localhost psql -c "select 1"',
  'Authorization: Bearer abcdefghijklmnop1234567890',
  'postgres://admin:s3cr3t@db.internal:5432/app',
  'The quick brown fox jumps over the lazy dog; key: value, other: thing # comment',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
].join('\n');

const repeatTo = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

describe('redaction performance', () => {
  it('handles 64 KiB of realistic input quickly', () => {
    const text = repeatTo(`${BLOCK}\n`, 64 * KIB);
    assert.ok(fitsBudget(50, 5, () => redactSecrets(text)));
  });

  const SIZE = 256 * KIB;
  const adversarial: readonly (readonly [string, string])[] = [
    ['a', 'a'],
    ['token-', 'token-'],
    ['a:', 'a:'],
    ['a=b ', 'a=b '],
    ['http://u:', 'http://u:'],
    ['a://b:@', 'a://b:@'],
    ['x://u: @a', `x://u:${'@a'.repeat(SIZE)}`],
    ['http://h:1/@', 'http://h:1/@'],
    ['mysql ', 'mysql '],
    ['curl ', 'curl '],
    ['curl -u ', 'curl -u '],
    ['set -x ', 'set -x '],
    ['Bearer ', 'Bearer '],
    ['Basic AAAA', `Basic ${'A'.repeat(SIZE)}`],
    ['private key header', '-----BEGIN PRIVATE KEY-----'],
    ['unterminated quote', `"password": "${'a'.repeat(SIZE)}`],
    ['escaped backslashes', `password=\\"${'\\\\'.repeat(SIZE)}`],
    ['placeholder', 'token: $A '],
    ['flag', '--token '],
    ['fish quote', 'set -gx A "'],
    ['quoted flag', '"-u" '],
    ['block scalar', 'a: |\n  b\n'],
    ['openai dashes', `sk-${'-'.repeat(SIZE)}`],
    ['jwt prefixes', `eyJ${'a'.repeat(9)}.`],
  ];
  for (const [name, unit] of adversarial) {
    it(`stays linear on ${name}`, () => {
      const text = repeatTo(unit, SIZE);
      assert.ok(fitsBudget(250, 3, () => redactSecrets(text)));
    });
  }

  const deep: readonly (readonly [string, () => unknown])[] = [
    [
      '10,000 keys',
      () => Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `v${i}`])),
    ],
    ['10,000 strings', () => Array.from({ length: 10_000 }, (_, i) => `value ${i} password=x${i}`)],
    [
      '5000 colliding keys',
      () =>
        Object.fromEntries(
          Array.from({ length: 5000 }, (_, i) => [`ghp_${String(i).padStart(36, '1')}`, i]),
        ),
    ],
  ];
  for (const [name, make] of deep) {
    it(`walks ${name} quickly`, () => {
      const value = make();
      assert.ok(fitsBudget(100, 3, () => redactDeep(value)));
    });
  }
});
