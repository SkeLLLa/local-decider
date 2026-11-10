import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactDeep, redactSecrets } from '../src/index.ts';

describe('redactSecrets', () => {
  const cases: readonly [string, string, string][] = [
    ['anthropic', 'key sk-ant-api03-abcdefghijklmnopqrstuv end', 'anthropic-key'],
    ['openai', 'OPENAI sk-proj-abcdefghijklmnopqrstuvwx', 'openai-key'],
    ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'],
    ['aws', 'AKIAABCDEFGHIJKLMNOP', 'aws-access-key'],
    ['slack', 'xoxb-1234567890-abcdef', 'slack-token'],
    ['npm', 'npm_abcdefghijklmnopqrstuvwxyz0123456789', 'npm-token'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'jwt'],
  ];
  for (const [name, input, kind] of cases) {
    it(`redacts ${name}`, () => {
      const out = redactSecrets(input);
      assert.match(out.text, new RegExp(`\\[REDACTED:${kind}\\]`));
      assert.equal(out.counts[kind], 1);
    });
  }

  it('keeps the scheme of bearer headers', () => {
    const out = redactSecrets('Authorization: Bearer abcdefghijklmnop123');
    assert.equal(out.text, 'Authorization: Bearer [REDACTED:bearer]');
  });

  it('keeps the key name of secret assignments', () => {
    assert.equal(
      redactSecrets('DB_PASSWORD=hunter2hunter').text,
      'DB_PASSWORD=[REDACTED:assignment]',
    );
    assert.equal(
      redactSecrets('{"api_key": "abcd1234"}').text,
      '{"api_key": "[REDACTED:assignment]"}',
    );
  });

  it('keeps host and user of URL credentials', () => {
    assert.equal(
      redactSecrets('postgres://admin:s3cr3t@db:5432/x').text,
      'postgres://admin:[REDACTED:url-credentials]@db:5432/x',
    );
  });

  it('redacts private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----';
    assert.equal(redactSecrets(`a ${pem} b`).text, 'a [REDACTED:private-key] b');
  });

  it('leaves ordinary text alone', () => {
    const text = 'git commit -m "fix token parsing" && ls -la';
    assert.equal(redactSecrets(text).text, text);
  });
});

describe('redactDeep', () => {
  it('redacts nested strings and keeps other values', () => {
    const out = redactDeep({ a: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 1], b: { c: null } });
    assert.deepEqual(out, { a: ['[REDACTED:github-token]', 1], b: { c: null } });
  });
});
