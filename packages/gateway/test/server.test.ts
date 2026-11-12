import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startGateway, type Gateway } from '../src/runtime.ts';
import { FakeEngine, readLog, tempPaths, testConfig } from './helpers.ts';

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('routing presets per harness', () => {
  it('attaches the harness target of a routing action and fills models for savings', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig({
        policies: { routing: { mode: 'act' } },
        routing: {
          presets: {
            'claude-code': { fast: { model: 'haiku' } },
            'paseo': { fast: { profile: 'implementer-luna', thinking: 'xhigh' } },
            'codex': { fast: { model: 'gpt-6-luna', thinking: 'xhigh' } },
          },
        },
      }),
      paths,
      engine: new FakeEngine({ fast: 0.9, standard: 0.05, deep: 0.05 }),
      env: {},
    });
    const decide = async (harness: string): Promise<Record<string, unknown>> =>
      json(
        await fetch(`${gw.url}/v1/decide/routing`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ harness, input: { prompt: 'rename foo' } }),
        }),
      );
    try {
      const claude = await decide('claude-code');
      assert.equal(claude['action'], 'route:fast');
      assert.deepEqual(claude['route'], { preset: 'fast', model: 'haiku' });
      assert.deepEqual((await decide('codex'))['route'], {
        preset: 'fast',
        model: 'gpt-6-luna',
        thinking: 'xhigh',
      });
      assert.deepEqual((await decide('paseo'))['route'], {
        preset: 'fast',
        thinking: 'xhigh',
        profile: 'implementer-luna',
      });
      assert.equal((await decide('mcp'))['route'], undefined, 'mcp has no mapping');
    } finally {
      await gw.close();
    }
  });

  it('resolves a profile preset to a routed model from the harness profile models', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig({
        policies: { routing: { mode: 'act' } },
        routing: { presets: { paseo: { fast: { profile: 'implementer-luna' } } } },
      }),
      paths,
      engine: new FakeEngine({ fast: 0.9, standard: 0.05, deep: 0.05 }),
      env: {},
    });
    try {
      const res = await fetch(`${gw.url}/v1/decide/routing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          harness: 'paseo',
          input: { prompt: 'rename foo' },
          models: {
            requested: 'claude/claude-opus-5-5',
            profiles: { 'implementer-luna': 'codex/gpt-6-luna' },
          },
        }),
      });
      const id = (await json(res))['decisionId'];
      const record = readLog(paths).find((r) => r.kind === 'decision' && r.decisionId === id);
      assert.ok(record?.kind === 'decision');
      assert.equal(record.requestedModel, 'claude/claude-opus-5-5');
      assert.equal(record.routedModel, 'codex/gpt-6-luna');
    } finally {
      await gw.close();
    }
  });
});

describe('gateway precedent', () => {
  it('learns from outcomes posted for escalated requests', async () => {
    const paths = tempPaths();
    const reportTokenFile = join(paths.config, 'report-token');
    const gw = await startGateway({
      config: testConfig({ policies: { permission: { mode: 'act' } } }),
      paths,
      engine: new FakeEngine({ allow: 0.7, ask: 0.2, deny: 0.1 }),
      env: {},
    });
    const reportToken = readFileSync(reportTokenFile, 'utf8');
    const decide = async (): Promise<Record<string, unknown>> =>
      json(
        await fetch(`${gw.url}/v1/decide/permission`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            harness: 'paseo',
            input: { project: '/project', subject: 'Bash: npm test', request: 'npm test' },
          }),
        }),
      );
    try {
      const forged = await decide();
      assert.equal(forged['action'], 'ask');
      assert.equal(
        (
          await fetch(`${gw.url}/v1/outcomes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              decisionId: forged['decisionId'],
              outcome: 'allow',
              source: 'user',
            }),
          })
        ).status,
        200,
      );
      const forgedRecord = readLog(paths).findLast(
        (record) => record.kind === 'outcome' && record.decisionId === forged['decisionId'],
      );
      assert.equal(
        forgedRecord?.kind === 'outcome' ? forgedRecord.source : undefined,
        'unverified',
      );
      assert.equal(forgedRecord?.kind === 'outcome' ? forgedRecord.verified : undefined, false);
      const unaffected = await decide();
      assert.equal(unaffected['action'], 'ask');
      assert.deepEqual(unaffected['precedent'], { allows: 0, denies: 0 });

      for (let index = 0; index < 3; index += 1) {
        const result = await decide();
        assert.equal(result['action'], 'ask');
        assert.equal(
          (
            await fetch(`${gw.url}/v1/outcomes`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-local-decider-report': reportToken,
              },
              body: JSON.stringify({
                decisionId: result['decisionId'],
                outcome: 'allow',
                source: 'user',
              }),
            })
          ).status,
          200,
        );
      }
      const verifiedRecord = readLog(paths).findLast(
        (record) => record.kind === 'outcome' && record.verified === true,
      );
      assert.equal(verifiedRecord?.kind === 'outcome' ? verifiedRecord.source : undefined, 'user');
      const learned = await decide();
      assert.equal(learned['action'], 'allow');
      assert.deepEqual(learned['precedent'], { allows: 3, denies: 0 });
      assert.equal(JSON.stringify(readLog(paths)).includes(reportToken), false);
    } finally {
      await gw.close();
    }
  });
});

describe('gateway HTTP', () => {
  let gw: Gateway;
  const logPaths = tempPaths();
  let configDir = '';
  const engine = new FakeEngine({ done: 0.9, needs_input: 0.05, stuck: 0.03, failed: 0.02 });

  before(async () => {
    configDir = logPaths.config;
    gw = await startGateway({ config: testConfig(), paths: logPaths, engine, env: {} });
  });
  after(async () => gw.close());

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    fetch(`${gw.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('GET /health and /ping report the engine', async () => {
    for (const path of ['/health', '/ping']) {
      const body = await json(await fetch(`${gw.url}${path}`));
      assert.equal(body['status'], 'ok');
      assert.equal(body['engine'], 'fake');
      assert.equal(body['engineTag'], 'fake');
    }
  });

  it('GET /models and /v1/policies', async () => {
    const models = await json(await fetch(`${gw.url}/models`));
    assert.ok(Array.isArray(models['models']));
    const policies = (await (await fetch(`${gw.url}/v1/policies`)).json()) as { id: string }[];
    assert.deepEqual(policies.map((p) => p.id).toSorted(), [
      'command-risk',
      'permission',
      'routing',
      'routing-budget',
      'routing-task-kind',
      'turn-outcome',
    ]);
    const routing = policies.find((p) => p.id === 'routing') as Record<string, unknown>;
    assert.deepEqual(routing['routes'], ['fast', 'deep', 'standard']);
    assert.equal(routing['variant'], 'routing');
    assert.deepEqual(routing['variants'], ['routing', 'routing-budget', 'routing-task-kind']);
    const budget = policies.find((p) => p.id === 'routing-budget') as Record<string, unknown>;
    assert.equal(budget['variantOf'], 'routing');
  });

  it('policy variant and reload routes need a switchable engine', async () => {
    assert.equal((await post('/v1/policies/routing/variant', { variant: 'x' })).status, 409);
    assert.equal((await post('/v1/policies/reload', {})).status, 409);
  });

  it('POST /v1/decide/:policy runs a policy', async () => {
    const res = await post('/v1/decide/turn-outcome', {
      harness: 'paseo',
      input: { lastMessage: 'done' },
    });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body['action'], 'log');
    assert.equal(body['enforced'], false);
  });

  it('validates requests', async () => {
    assert.equal(
      (await post('/v1/decide/turn-outcome', { harness: 'evil', input: {} })).status,
      400,
    );
    assert.equal((await post('/v1/decide/turn-outcome', { harness: 'cli' })).status, 400);
    assert.equal((await post('/v1/decide/turn-outcome', '{nope')).status, 400);
    assert.equal((await post('/v1/decide/missing', { harness: 'cli', input: {} })).status, 404);
    assert.equal((await post('/v1/decide/../../etc', { harness: 'cli', input: {} })).status, 404);
    assert.equal((await post('/v1/systemone', { state: 'x' })).status, 400);
    assert.equal((await fetch(`${gw.url}/nope`)).status, 404);
  });

  it('rejects oversized bodies', async () => {
    const res = await post('/v1/decide/turn-outcome', {
      harness: 'cli',
      input: { lastMessage: 'x'.repeat(300 * 1024) },
    });
    assert.equal(res.status, 413);
  });

  it('POST /v1/systemone passes through', async () => {
    const res = await post('/v1/systemone', {
      state: 's',
      questions: { q: { type: 'choice', instructions: 'i', criteria: { done: 'a', stuck: 'b' } } },
    });
    const body = await json(res);
    assert.ok(typeof body['answers'] === 'object');
  });

  it('records outcomes and serves stats', async () => {
    const decision = await json(
      await post('/v1/decide/turn-outcome', { harness: 'cli', input: { lastMessage: 'ok' } }),
    );
    assert.equal(
      (
        await post('/v1/outcomes', {
          decisionId: decision['decisionId'],
          outcome: 'done',
          source: 'supervised',
        })
      ).status,
      200,
    );
    const outcome = readLog(logPaths).findLast(
      (record) => record.kind === 'outcome' && record.decisionId === decision['decisionId'],
    );
    assert.equal(outcome?.kind === 'outcome' ? outcome.source : undefined, 'unverified');
    assert.equal(outcome?.kind === 'outcome' ? outcome.verified : undefined, false);
    assert.equal((await post('/v1/outcomes', { outcome: 'done' })).status, 400);
    const stats = (await (await fetch(`${gw.url}/v1/stats`)).json()) as {
      policy: string;
      labelled: number;
    }[];
    assert.equal(stats.find((s) => s.policy === 'turn-outcome')?.labelled, 1);
    const reportToken = readFileSync(join(configDir, 'report-token'), 'utf8');
    assert.equal(JSON.stringify(readLog(logPaths)).includes(reportToken), false);
  });

  it('records usage against a decision and reports token savings', async () => {
    const decision = await json(
      await post('/v1/decide/turn-outcome', {
        harness: 'cli',
        input: { lastMessage: 'ok' },
        models: {
          requested: 'claude/claude-opus-4-6[1m]',
          routes: { log: 'claude/haiku', bad: 'no spaces allowed' },
        },
      }),
    );
    const usage = {
      decisionId: decision['decisionId'],
      turnId: 't1',
      model: 'claude/claude-opus-4-6[1m]',
      inputTokens: 1000,
      cachedInputTokens: 5000,
      outputTokens: 200,
    };
    assert.equal((await post('/v1/usage', usage)).status, 200);
    assert.equal((await post('/v1/usage', usage)).status, 200, 'a repeated turn counts once');
    assert.equal((await post('/v1/usage', { ...usage, inputTokens: -1 })).status, 400);
    const stats = (await (await fetch(`${gw.url}/v1/stats`)).json()) as {
      policy: string;
      savings?: {
        potential: { moved: number; tokens: { input: number }; moves: { from: string }[] };
      };
    }[];
    const potential = stats.find((s) => s.policy === 'turn-outcome')?.savings?.potential;
    assert.equal(potential?.moved, 1);
    assert.equal(potential.tokens.input, 1000);
    assert.equal(potential.moves[0]?.from, 'claude/claude-opus-4-6[1m]');
  });

  it('serves MCP tools/list and decide', async () => {
    const headers = { accept: 'application/json, text/event-stream' };
    const list = await json(
      await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers),
    );
    const tools = (list['result'] as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(tools.toSorted(), ['decide', 'policies']);
    const call = await json(
      await post(
        '/mcp',
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'decide',
            arguments: { policy: 'turn-outcome', input: { lastMessage: 'done' } },
          },
        },
        headers,
      ),
    );
    const text = (call['result'] as { content: { text: string }[] }).content[0]?.text ?? '';
    assert.equal((JSON.parse(text) as { action: string }).action, 'log');
  });
});

describe('gateway browser guard', () => {
  let gw: Gateway;
  before(async () => {
    gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: {},
    });
  });
  after(async () => gw.close());

  const port = (): string => new URL(gw.url).port;
  /** Raw request so Host and Origin can be set (fetch forbids both). */
  function raw(
    headers: Record<string, string>,
    method = 'POST',
    body = '{"harness":"cli","input":{}}',
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: port(), path: '/v1/decide/turn-outcome', method, headers },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(method === 'POST' ? body : undefined);
    });
  }

  it('answers 400 to a request target URL cannot parse, and keeps serving', async () => {
    const status = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port()), '127.0.0.1', () => {
        socket.end('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => (data += String(chunk)));
      socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      socket.on('error', reject);
    });
    assert.match(status, / 400 /);
    assert.equal((await fetch(`${gw.url}/health`)).status, 200);
  });

  it('refuses text/plain POSTs (no CORS preflight)', async () => {
    assert.equal(await raw({ 'content-type': 'text/plain' }), 403);
    assert.equal(await raw({}), 403);
  });

  it('refuses non-loopback Host headers (DNS rebinding)', async () => {
    assert.equal(
      await raw({ 'content-type': 'application/json', 'host': `evil.example:${port()}` }),
      403,
    );
  });

  it('refuses foreign browser origins, including null', async () => {
    assert.equal(
      await raw({ 'content-type': 'application/json', 'origin': 'https://evil.example' }),
      403,
    );
    assert.equal(await raw({ 'content-type': 'application/json', 'origin': 'null' }), 403);
  });

  it('accepts loopback JSON requests', async () => {
    assert.equal(await raw({ 'content-type': 'application/json; charset=utf-8' }), 200);
    assert.equal(
      await raw({
        'content-type': 'application/json',
        'host': `localhost:${port()}`,
        'origin': 'http://localhost:3000',
      }),
      200,
    );
    assert.equal(await raw({}, 'GET'), 404);
  });

  it('reports which models fit in memory', async () => {
    const body = (await (await fetch(`${gw.url}/models`)).json()) as {
      totalMemoryGb: number;
      models: { fits: boolean }[];
    };
    assert.ok(body.totalMemoryGb > 0);
    assert.ok(body.models.every((m) => typeof m.fits === 'boolean'));
  });
});

describe('gateway auth', () => {
  it('refuses a non-loopback bind without a token', async () => {
    await assert.rejects(
      startGateway({
        config: testConfig({ host: '0.0.0.0' }),
        paths: tempPaths(),
        engine: new FakeEngine(),
        env: {},
      }),
      /LOCAL_DECIDER_TOKEN/,
    );
  });

  it('requires the bearer token when one is set', async () => {
    const token = 'a-very-long-test-token';
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: { LOCAL_DECIDER_TOKEN: token },
    });
    try {
      assert.equal((await fetch(`${gw.url}/health`)).status, 401);
      assert.equal(
        (await fetch(`${gw.url}/health`, { headers: { authorization: 'Bearer wrong' } })).status,
        401,
      );
      assert.equal(
        (await fetch(`${gw.url}/health`, { headers: { authorization: `Bearer ${token}` } })).status,
        200,
      );
    } finally {
      await gw.close();
    }
  });
});
