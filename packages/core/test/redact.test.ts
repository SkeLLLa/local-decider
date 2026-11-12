import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactDeep, redactSecrets } from '../src/index.ts';

const alnum = (n: number): string =>
  'aB3dE5gH7jK9mN1pQ3sT5vW7yZ'.repeat(Math.ceil(n / 26)).slice(0, n);
const hex = (n: number): string => 'a1b2c3d4e5f60718'.repeat(Math.ceil(n / 16)).slice(0, n);
const GH = `ghp_${alnum(36)}`;
const GH_KEY = `ghp_${'1'.repeat(36)}`;
const GH_KEY2 = `ghp_${'2'.repeat(36)}`;

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

describe('redactSecrets shapes', () => {
  const cases: readonly [string, string, string][] = [
    ['stripe live', `sk_live_${alnum(24)}`, 'stripe-key'],
    ['stripe restricted', `rk_test_${alnum(24)}`, 'stripe-key'],
    ['stripe webhook', `whsec_${alnum(32)}`, 'stripe-webhook-secret'],
    ['sendgrid', `SG.${alnum(22)}.${alnum(43)}`, 'sendgrid-key'],
    ['huggingface', `hf_${alnum(34)}`, 'huggingface-token'],
    ['google oauth', `ya29.${alnum(30)}`, 'google-oauth-token'],
    ['pypi', `pypi-AgEIcHlwaS5vcmc${alnum(40)}`, 'pypi-token'],
    ['docker', `dckr_pat_${alnum(27)}`, 'docker-token'],
    ['digitalocean', `dop_v1_${hex(64)}`, 'digitalocean-token'],
    ['shopify', `shpat_${hex(32)}`, 'shopify-token'],
    ['slack app', `xapp-1-${alnum(20)}`, 'slack-token'],
    [
      'openssh key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      'private-key',
    ],
    [
      'pgp key',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nabc\n-----END PGP PRIVATE KEY BLOCK-----',
      'private-key',
    ],
  ];
  for (const [name, input, kind] of cases) {
    it(`redacts ${name} exactly once and idempotently`, () => {
      const out = redactSecrets(input);
      assert.equal(out.text, `[REDACTED:${kind}]`);
      assert.deepEqual(out.counts, { [kind]: 1 });
      assert.deepEqual(redactSecrets(out.text), { text: out.text, counts: {} });
    });
  }

  for (const text of [`pk_live_${alnum(24)}`, 'sk_live_short', 'hf_model', 'SG.short.x']) {
    it(`leaves ${text.slice(0, 12)} alone`, () => {
      assert.equal(redactSecrets(text).text, text);
    });
  }
});

describe('redactSecrets bearer and basic', () => {
  it('redacts a Basic credential', () => {
    assert.equal(redactSecrets('Basic dXNlcjpwYXNzd29yZA==').text, 'Basic [REDACTED:bearer]');
  });
  for (const prose of [
    'Bearer authentication is used',
    'Basic authentication is required',
    'Basic Authentication',
    'Basic abcdefgh',
  ]) {
    it(`keeps prose: ${prose}`, () => {
      assert.equal(redactSecrets(prose).text, prose);
    });
  }
});

type Case = readonly [string, string];
type Counted = readonly [string, string, Record<string, number>];

const KEYED: readonly Case[] = [
  ['set -gx PASSWORD $PW TAIL', 'set -gx PASSWORD [REDACTED:assignment]'],
  ['set -gx PASSWORD [REDACTED:x] TAIL', 'set -gx PASSWORD [REDACTED:assignment]'],
  ['set -gx PASSWORD A $PW B', 'set -gx PASSWORD [REDACTED:assignment]'],
  ['set -gx PASSWORD A B $PW', 'set -gx PASSWORD [REDACTED:assignment]'],
  ['"password=abc"TAIL', '"password=[REDACTED:assignment]'],
  ["'password=abc'TAIL", "'password=[REDACTED:assignment]"],
  ['"Authorization: abc"TAIL', '"Authorization: [REDACTED:assignment]'],
  ["'Authorization: abc'TAIL", "'Authorization: [REDACTED:assignment]"],
  ['\\"password=abc\\"TAIL', '\\"password=[REDACTED:assignment]'],
  ['\\"Authorization: abc\\"TAIL', '\\"Authorization: [REDACTED:assignment]'],
  ['{"a":"password: x","b":1}', '{"a":"password: [REDACTED:assignment]","b":1}'],
  ['password: |2\n  SECRET\n  TAIL\nnext: ok', 'password: [REDACTED:assignment]\nnext: ok'],
  ['password: >+1\n  SECRET\nnext: ok', 'password: [REDACTED:assignment]\nnext: ok'],
  ['password=$PW,TAIL', 'password=[REDACTED:assignment]'],
  ['password=[REDACTED:x],TAIL', 'password=[REDACTED:assignment]'],
  ['set -gx PASSWORD "abc"TAIL', 'set -gx PASSWORD [REDACTED:assignment]'],
  ['set -gx PASSWORD a b c; echo x', 'set -gx PASSWORD [REDACTED:assignment]; echo x'],
  ["password: 'a''b'", "password: '[REDACTED:assignment]'"],
  [
    'curl -H "Authorization: Digest a=b" https://x/y -d z',
    'curl -H "Authorization: Digest [REDACTED:assignment]" https://x/y -d z',
  ],
  [
    'curl -H "Authorization: Digest x=\\"a\\", y=\\"b\\"" https://x',
    'curl -H "Authorization: Digest [REDACTED:assignment]" https://x',
  ],
  ["echo 'password: x' > f", "echo 'password: [REDACTED:assignment]' > f"],
  ['echo "PASSWORD=x" > f', 'echo "PASSWORD=[REDACTED:assignment]" > f'],
  ['Authorization: Bearer abc\\ndef', 'Authorization: Bearer [REDACTED:assignment]'],
  ['secret: |\n  line1\n\n  line2\nnext: 1', 'secret: [REDACTED:assignment]\nnext: 1'],
  ['a:\n  secret: >-\n    l1\n  keep: 1', 'a:\n  secret: [REDACTED:assignment]\n  keep: 1'],
  ['{"password": "a b c"}', '{"password": "[REDACTED:assignment]"}'],
  ["TOKEN='x y z'", "TOKEN='[REDACTED:assignment]'"],
  ['password=\'abc\'"def" next', 'password=[REDACTED:assignment] next'],
  ['{\\"api_key\\": \\"ab\\\\\\"cd\\"}', '{\\"api_key\\": \\"[REDACTED:assignment]\\"}'],
  ['password: "line1\nline2" x', 'password: "[REDACTED:assignment]" x'],
  [`secret: "${'a'.repeat(100)}`, 'secret: "[REDACTED:assignment]'],
  ['password=abc,def', 'password=[REDACTED:assignment]'],
  ['password=x', 'password=[REDACTED:assignment]'],
  ['password: hunter 2 # c', 'password: [REDACTED:assignment] # c'],
  ['password: str = "x"', 'password: [REDACTED:assignment]'],
  ['export GITHUB_TOKEN=abcd1234', 'export GITHUB_TOKEN=[REDACTED:assignment]'],
  ['PGPASSWORD=hunter22 psql', 'PGPASSWORD=[REDACTED:assignment] psql'],
  ['set -gx HF_TOKEN abcd1234', 'set -gx HF_TOKEN [REDACTED:assignment]'],
  ['Cookie: a=1; sid=abcdef', 'Cookie: [REDACTED:assignment]'],
  ['Authorization: token abcd1234', 'Authorization: token [REDACTED:assignment]'],
  [
    'Authorization: Digest username="a", response="b"',
    'Authorization: Digest [REDACTED:assignment]',
  ],
  [
    `curl -H 'Authorization: Digest username="a", response="b"' x`,
    `curl -H 'Authorization: Digest [REDACTED:assignment]' x`,
  ],
  [
    '{"authorization": "Digest username=\\"a\\", response=\\"b\\""}',
    '{"authorization": "Digest [REDACTED:assignment]"}',
  ],
  ['X-Api-Key: abcd1234', 'X-Api-Key: [REDACTED:assignment]'],
  [
    'AccountKey=abc123def456==;EndpointSuffix=x',
    'AccountKey=[REDACTED:assignment];EndpointSuffix=x',
  ],
  ['https://x/y?sig=abcd%2Bef&se=1', 'https://x/y?sig=[REDACTED:assignment]&se=1'],
  ['password: xxx', 'password: [REDACTED:assignment]'],
  ['password: "<pw>"', 'password: "[REDACTED:assignment]"'],
  ['password: false', 'password: [REDACTED:assignment]'],
  [
    '"password": null',
    '"password": "[REDACTED:assignment]"'.replace(
      '"[REDACTED:assignment]"',
      '[REDACTED:assignment]',
    ),
  ],
  ['Authorization: Bearer abcdefghijklmnop123', 'Authorization: Bearer [REDACTED:bearer]'],
];

const UNCHANGED: readonly string[] = [
  'max_tokens=4096',
  '"max_tokens": 4096',
  'token_count: 1234',
  'tokens_used=99',
  'num_tokens: 12',
  'tokenizer: cl100k_base',
  'token_type: Bearer',
  'token == "abc"',
  'session_id: 1234abcd',
  'secretary: Ann',
  'password: $DB_PASSWORD',
  'token: ${{ secrets.T }}',
  'api_key: process.env.API_KEY',
  "password: os.getenv('PW')",
  'git commit -m "fix token parsing" && ls -la',
  'mkdir -p src/a',
  'git log -p',
  'mysql -p db',
  'docker login --password-stdin -u x',
  'docker login --token-file ./t',
  'curl -u bob x',
  'http://localhost:3000/@vite/client',
  'https://host:8443/x',
];

const CLI: readonly Case[] = [
  ['"curl" -u bob:SECRET x', '"curl" -u bob:[REDACTED:cli-password] x'],
  ["'mysql' -pSECRET db", "'mysql' -p[REDACTED:cli-password] db"],
  ['--password --SECRET', '--password [REDACTED:cli-flag]'],
  ['curl "-u" bob:SECRET x', 'curl "-u" bob:[REDACTED:cli-password] x'],
  ['curl "-ubob:SECRET" x', 'curl "-ubob:[REDACTED:cli-password]" x'],
  ['--token abcd1234', '--token [REDACTED:cli-flag]'],
  ['--password -x1y2', '--password [REDACTED:cli-flag]'],
  ['--password=hunter22', '--password=[REDACTED:cli-flag]'],
  ['mysql -u root -phunter22 db', 'mysql -u root -p[REDACTED:cli-password] db'],
  ["mysqldump -p'a b' db", "mysqldump -p'[REDACTED:cli-password]' db"],
  ['sudo mysql -pXY', 'sudo mysql -p[REDACTED:cli-password]'],
  ['echo curl mysql -pXY', 'echo curl mysql -p[REDACTED:cli-password]'],
  ['sshpass -p hunter22 ssh h', 'sshpass -p [REDACTED:cli-password] ssh h'],
  ['redis-cli -h x -a -hunter22', 'redis-cli -h x -a [REDACTED:cli-password]'],
  ['curl -u bob:hunter22 https://x', 'curl -u bob:[REDACTED:cli-password] https://x'],
  ["curl -u 'bob:long secret' x", "curl -u 'bob:[REDACTED:cli-password]' x"],
  ['curl --user=bob:pw x', 'curl --user=bob:[REDACTED:cli-password] x'],
];

const ARGV: readonly (readonly string[])[] = [
  ['tool', '--password', '--SECRET'],
  ['curl', '"-u"', 'bob:SECRET'],
  ['sshpass', '-p', 'hunter22'],
  ['redis-cli', '-a', 'hunter22'],
  ['curl', '-u', 'bob:hunter22'],
  ['tool', '--password', '-x1y2'],
  ['mysql', '-phunter22'],
];

const URLS: readonly Case[] = [
  ['https://u:1234/SECRET/@host', 'https://u:[REDACTED:url-credentials]@host'],
  ['postgres://u:p@ss/w@db:5432/x', 'postgres://u:[REDACTED:url-credentials]@db:5432/x'],
  ['redis://:hunter22@h', 'redis://:[REDACTED:url-credentials]@h'],
  ['redis://:1234/secret@host', 'redis://:[REDACTED:url-credentials]@host'],
  ['https://u:1234@h/x', 'https://u:[REDACTED:url-credentials]@h/x'],
  [`https://u:${'p'.repeat(5000)}@h`, 'https://u:[REDACTED:url-credentials]@h'],
  ['https://u:p@registry.npmjs.org/@scope/pkg', 'https://u:[REDACTED:url-credentials]@scope/pkg'],
];

const MIXED: readonly Counted[] = [
  [`password=abc-${GH}`, 'password=[REDACTED:assignment]', { 'github-token': 1, 'assignment': 1 }],
  [
    `{"cookie": "sid=${GH}", "x": 1}`,
    '{"cookie": "[REDACTED:assignment]", "x": 1}',
    { 'github-token': 1, 'assignment': 1 },
  ],
];

describe('redactSecrets keyed values, CLI and URLs', () => {
  for (const [input, expected] of [...KEYED, ...CLI, ...URLS]) {
    it(`redacts ${input.slice(0, 40).replace(/\n/g, ' ')}`, () => {
      const once = redactSecrets(input);
      assert.equal(once.text, expected);
      assert.ok(Object.values(once.counts).length > 0);
      assert.deepEqual(redactSecrets(once.text), { text: once.text, counts: {} });
    });
  }
  for (const input of UNCHANGED) {
    it(`leaves ${input.slice(0, 40)} alone`, () => {
      assert.deepEqual(redactSecrets(input), { text: input, counts: {} });
    });
  }
  for (const [input, expected, counts] of MIXED) {
    it(`counts nested kinds for ${input.slice(0, 20)}`, () => {
      const once = redactSecrets(input);
      assert.equal(once.text, expected);
      assert.deepEqual(once.counts, counts);
      assert.deepEqual(redactSecrets(once.text).counts, {});
    });
  }
  it('redacts a long quoted value fully', () => {
    const out = redactSecrets(`password: "${'z'.repeat(10240)}" tail`);
    assert.equal(out.text, 'password: "[REDACTED:assignment]" tail');
  });
  it('still redacts a value glued to a label', () => {
    assert.equal(
      redactSecrets('password=[REDACTED:x]hunter2').text,
      'password=[REDACTED:assignment]',
    );
  });
});

describe('redactDeep argv', () => {
  for (const argv of ARGV) {
    it(`redacts ${argv.join(' ').replace(/hunter22|x1y2/, '*')}`, () => {
      const once = redactDeep([...argv]);
      assert.notDeepEqual(once, argv);
      assert.ok(once.some((s) => s.includes('[REDACTED:cli-')));
      assert.ok(!JSON.stringify(once).includes('hunter22'));
      assert.ok(!JSON.stringify(once).includes('x1y2'));
      assert.ok(!JSON.stringify(once).includes('SECRET'));
      assert.deepEqual(redactDeep(once), once);
    });
  }
  it('keeps prompting mysql -p', () => {
    assert.deepEqual(redactDeep(['mysql', '-p', 'db']), ['mysql', '-p', 'db']);
  });
});

const SECRET_KEYS = [
  'password',
  'DB_PASSWORD',
  'PGPASSWORD',
  'passwd',
  'MYSQL_PWD',
  'db_pass',
  'pass',
  'passwords',
  'passphrase',
  'password_hash',
  'spring.datasource.password',
  'secret',
  'secrets',
  'client_secret',
  'secret_id',
  'AWS_SECRET_ACCESS_KEY',
  'SECRETKEY',
  'api_key',
  'apiKey',
  'APIKEY',
  'x-api-key',
  'X-Api-Key',
  'OPENAI_API_KEY',
  'access_key',
  'private_key',
  'AccountKey',
  'SharedAccessKey',
  'authorization',
  'Proxy-Authorization',
  'cookie',
  'Set-Cookie',
  'credentials',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'authToken',
  '_authToken',
  'GITHUB_TOKEN',
  'HF_TOKEN',
  'session_token',
  'session_key',
  'with_token',
  'auth',
  'auths',
  'auth_method',
  'sig',
  'X-Amz-Signature',
  'GITLAB_PAT',
  'input_password',
  'max_api_key',
  'print_secret',
  'authorization_header',
  'password_hint',
  'no_password',
  'password_min_length',
  'password_policy',
  'secret_count',
  'secretKeyRef',
  'cookie_domain',
];
const PLAIN_KEYS = [
  'max_tokens',
  'maxTokens',
  'token_count',
  'tokenCount',
  'tokens_used',
  'num_tokens',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'tokens',
  'tokenizer',
  'token_type',
  'token_url',
  'tokenEnv',
  'token_expires_at',
  'password_file',
  'PASSWORD_FILE',
  'password-stdin',
  'token-file',
  'secret_name',
  'secret_arn',
  'api_key_env',
  'cookie_name',
  'session',
  'session_id',
  'sessionId',
  'PWD',
  'OLDPWD',
  'pageToken',
  'next_page_token',
  'secretary',
  'key',
  'monkey',
  'author',
  'subject',
  'tool',
  'request',
  'history',
  'project',
  'task',
  'model',
  'questions',
  'criteria',
  'instructions',
  'state',
  'command',
  'cwd',
  'verdict',
  'allow',
  'ask',
  'deny',
  'type',
  'options',
  'labels',
];

describe('redactDeep key classification', () => {
  for (const k of SECRET_KEYS) {
    it(`treats ${k} as secret`, () => {
      assert.deepEqual(redactDeep({ [k]: 'v4lue-xyz' }), { [k]: '[REDACTED:secret-field]' });
    });
  }
  for (const k of PLAIN_KEYS) {
    it(`treats ${k} as plain`, () => {
      assert.deepEqual(redactDeep({ [k]: 'v4lue-xyz' }), { [k]: 'v4lue-xyz' });
    });
  }
});

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
};

describe('redactDeep values and graph shape', () => {
  it('redacts nested strings and keeps other values', () => {
    const out = redactDeep({ a: ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 1], b: { c: null } });
    assert.deepEqual(out, { a: ['[REDACTED:github-token]', 1], b: { c: null } });
  });
  it('redacts non-string leaves under secret keys', () => {
    assert.deepEqual(redactDeep({ password: 1234 }), { password: '[REDACTED:secret-field]' });
    assert.deepEqual(redactDeep({ secrets: { DB: 'x', n: [1, 'y'] } }), {
      secrets: {
        DB: '[REDACTED:secret-field]',
        n: ['[REDACTED:secret-field]', '[REDACTED:secret-field]'],
      },
    });
    assert.deepEqual(redactDeep({ headers: { authorization: 'Bearer x', cookie: 'a=b' } }), {
      headers: { authorization: '[REDACTED:secret-field]', cookie: '[REDACTED:secret-field]' },
    });
  });
  it('keeps booleans, nulls, empties and references', () => {
    const v = { token: true, password: null, secret: '', api_key: '$API_KEY' };
    assert.deepEqual(redactDeep(v), v);
    const u = { usage: { max_tokens: 10, tokens: 5 } };
    assert.deepEqual(redactDeep(u), u);
  });
  it('redacts secret-shaped keys and resolves collisions', () => {
    assert.deepEqual(redactDeep({ [GH_KEY]: 1 }), { '[REDACTED:github-token]': 1 });
    assert.deepEqual(redactDeep({ [GH_KEY]: 1, [GH_KEY2]: 2 }), {
      '[REDACTED:github-token]': 1,
      '[REDACTED:github-token]#2': 2,
    });
    const existing = { '[REDACTED:github-token]#2': 'keep', [GH_KEY]: 1, [GH_KEY2]: 2 };
    const out = redactDeep(existing) as Record<string, unknown>;
    assert.equal(out['[REDACTED:github-token]#2'], 'keep');
    assert.equal(out['[REDACTED:github-token]'], 1);
    assert.equal(out['[REDACTED:github-token]#3'], 2);
  });
  it('allocates collisions independently of insertion order', () => {
    const a = redactDeep({ [GH_KEY]: 1, [GH_KEY2]: 2 });
    const b = redactDeep({ [GH_KEY2]: 2, [GH_KEY]: 1 });
    assert.equal(JSON.stringify(sortKeys(a)), JSON.stringify(sortKeys(b)));
    assert.deepEqual(redactDeep(a), a);
  });
  it('walks shared references, cycles and deep values', () => {
    const shared = { a: GH };
    assert.deepEqual(redactDeep({ x: shared, y: shared }), {
      x: { a: '[REDACTED:github-token]' },
      y: { a: '[REDACTED:github-token]' },
    });
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    assert.deepEqual(redactDeep(loop), { self: '[REDACTED:cycle]' });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10000; i++) deep = { n: deep };
    let cur: Record<string, unknown> = redactDeep(deep);
    for (let i = 0; i < 64; i++) cur = cur['n'] as Record<string, unknown>;
    assert.equal(cur, '[REDACTED:max-depth]');
  });
  it('keeps a whole SystemOneRequest structure', () => {
    const req = {
      state: { subject: 'x', history: [], tool: 'Bash' },
      questions: [
        {
          id: 'verdict',
          type: 'choice',
          instructions: 'pick',
          criteria: { allow: 'a', ask: 'b', deny: 'c' },
          options: ['allow', 'ask', 'deny'],
          labels: { allow: 'A' },
        },
      ],
    };
    assert.deepEqual(redactDeep(req), req);
  });
  it('shares precedent text across differing secrets', () => {
    assert.equal(redactSecrets('mysql -pA db').text, redactSecrets('mysql -pB db').text);
  });
});
