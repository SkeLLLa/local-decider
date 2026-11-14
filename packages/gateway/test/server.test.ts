import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MemoryConfigStore } from '../src/config-file.ts';
import { ENGINE_BENCHMARK_RUNNING_ERROR } from '../src/engine-busy.ts';
import { EngineControl } from '../src/engine-control.ts';
import { startGateway, type Gateway } from '../src/runtime.ts';
import {
  controlHeaders,
  FakeEngine,
  NO_CAPABILITIES,
  readLog,
  tempPaths,
  testConfig,
} from './helpers.ts';

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function directorySnapshot(directory: string): readonly (readonly [string, string])[] | undefined {
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory)
    .toSorted()
    .map((name) => [name, readFileSync(join(directory, name), 'base64')] as const);
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
            scope: 'claude-auto',
            workspace: { cwd: '/project' },
            input: { project: '/project', subject: 'Bash: npm test', request: 'npm test' },
          }),
        }),
      );
    try {
      const forged = await decide();
      assert.equal(forged['action'], 'ask');
      assert.deepEqual(forged['precedent'], { allows: 0, denies: 0 });
      const forgedOutcome = await fetch(`${gw.url}/v1/outcomes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decisionId: forged['decisionId'],
          outcome: 'allow',
          source: 'user',
        }),
      });
      assert.equal(forgedOutcome.status, 200);
      const forgedRecord = readLog(paths).findLast(
        (record) => record.kind === 'outcome' && record.decisionId === forged['decisionId'],
      );
      assert.equal(
        forgedRecord?.kind === 'outcome' ? forgedRecord.source : undefined,
        'unverified',
      );
      assert.equal(forgedRecord?.kind === 'outcome' ? forgedRecord.verified : undefined, false);
      for (const source of ['classifier', 'harness', 'user'] as const) {
        for (let index = 0; index < 20; index += 1) {
          const result = await decide();
          assert.equal(result['action'], 'ask');
          assert.deepEqual(result['precedent'], { allows: 0, denies: 0 });
          const outcome = await fetch(`${gw.url}/v1/outcomes`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              decisionId: result['decisionId'],
              outcome: 'allow',
              source,
            }),
          });
          assert.equal(outcome.status, 200);
        }
      }
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
      await fetch(`${gw.url}/v1/outcomes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decisionId: learned['decisionId'],
          outcome: 'deny',
          source: 'classifier',
        }),
      });
      const classifierRecord = readLog(paths).findLast(
        (record) => record.kind === 'outcome' && record.decisionId === learned['decisionId'],
      );
      assert.deepEqual(
        classifierRecord?.kind === 'outcome'
          ? [classifierRecord.source, classifierRecord.claimedSource, classifierRecord.verified]
          : [],
        ['unverified', 'classifier', false],
      );
      const vetoed = await decide();
      assert.equal(vetoed['action'], 'ask', JSON.stringify(vetoed));
      assert.deepEqual(vetoed['precedent'], { allows: 3, denies: 1 });
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
      headers: { 'content-type': 'application/json', ...controlHeaders(logPaths), ...headers },
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

  it('POST /v1/systemone returns 503 while the engine is held', async () => {
    gw.decider.hold(ENGINE_BENCHMARK_RUNNING_ERROR);
    try {
      const res = await post('/v1/systemone', {
        state: 's',
        questions: {
          q: { type: 'choice', instructions: 'i', criteria: { done: 'a', stuck: 'b' } },
        },
      });
      assert.equal(res.status, 503);
      assert.deepEqual(await json(res), { error: ENGINE_BENCHMARK_RUNNING_ERROR });
    } finally {
      gw.decider.hold(null);
    }
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

describe('control token', () => {
  let gw: Gateway;
  const paths = tempPaths();
  const engine = new FakeEngine();

  before(async () => {
    gw = await startGateway({ config: testConfig(), paths, engine, env: {} });
  });
  after(async () => gw.close());

  it('guards every control route before reading the request or causing effects', async () => {
    const routes = [
      ['GET', '/v1/engines'],
      ['POST', '/v1/engine'],
      ['POST', '/v1/engine/mode'],
      ['POST', '/v1/engine/load'],
      ['POST', '/v1/engine/unload'],
      ['POST', '/v1/engine/lifecycle'],
      ['POST', '/v1/models/download'],
      ['POST', '/v1/engines/validate'],
      ['POST', '/v1/engines/discover'],
      ['POST', '/v1/paths'],
      ['POST', '/v1/policies/reload'],
      ['POST', '/v1/policies/permission/mode'],
      ['POST', '/v1/policies/permission/variant'],
      ['POST', '/v1/policies/permission/thresholds'],
      ['GET', '/v1/config'],
      ['POST', '/v1/config/reload'],
      ['POST', '/v1/config/engine'],
      ['POST', '/v1/routing/presets'],
      ['GET', '/v1/policies/routing/prompt'],
    ] as const;
    const valid = controlHeaders(paths)['x-local-decider-control'] ?? '';
    const wrong = 'w'.repeat(valid.length);
    const stateBefore = engine.state;
    const configFile = join(paths.config, 'config.yaml');
    const configBefore = existsSync(configFile) ? readFileSync(configFile) : undefined;
    const policiesDirectory = join(paths.config, 'policies');
    const policiesBefore = directorySnapshot(policiesDirectory);
    for (const [method, path] of routes) {
      for (const headers of [
        {},
        { 'x-local-decider-control': wrong },
        { 'x-local-decider-control': '' },
      ]) {
        const res = await fetch(`${gw.url}${path}`, {
          method,
          headers: {
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        assert.equal(res.status, 401, `${method} ${path}`);
        assert.equal((await res.text()).includes(valid), false);
      }
    }
    assert.equal(engine.state, stateBefore);
    assert.equal(engine.requests.length, 0);
    assert.equal(existsSync(policiesDirectory), false);
    assert.deepEqual(directorySnapshot(policiesDirectory), policiesBefore);
    assert.equal(
      existsSync(configFile) ? readFileSync(configFile).toString() : undefined,
      configBefore?.toString(),
    );
  });

  it('leaves open routes available without a control token', async () => {
    for (const path of ['/health', '/ping', '/v1/policies']) {
      assert.notEqual((await fetch(`${gw.url}${path}`)).status, 401, path);
    }
    assert.equal(
      (
        await fetch(`${gw.url}/v1/decide/turn-outcome`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ harness: 'cli', input: {} }),
        })
      ).status,
      200,
    );
    assert.equal((await fetch(`${gw.url}/v1/calls/missing`)).status, 404);
    const mcp = await fetch(`${gw.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.notEqual(mcp.status, 401);
  });

  it('accepts a mixed-case control header name and rejects a duplicate header', async () => {
    const token = controlHeaders(paths)['x-local-decider-control'] ?? '';
    assert.equal(
      (await fetch(`${gw.url}/v1/engines`, { headers: { 'X-Local-Decider-Control': token } }))
        .status,
      409,
      'authentication passes before the injected engine 409',
    );
    const duplicate = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: Number(new URL(gw.url).port),
          path: '/v1/engines',
          headers: { 'x-local-decider-control': [token, token] },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(duplicate, 401);
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

  it('uses the bearer token, not the control header, on control routes in token mode', async () => {
    const token = 'a-very-long-test-token';
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine(),
      env: { LOCAL_DECIDER_TOKEN: token },
    });
    try {
      const route = `${gw.url}/v1/engines`;
      const bearerOnly = await fetch(route, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.notEqual(bearerOnly.status, 401);
      const controlOnly = await fetch(route, { headers: controlHeaders(paths) });
      assert.equal(controlOnly.status, 401);
    } finally {
      await gw.close();
    }
  });
});

describe('engine status stamps', () => {
  it('returns cached status without awaiting a blocked llama version probe', async () => {
    const paths = tempPaths();
    const bin = join(paths.data, 'bin');
    mkdirSync(bin, { recursive: true });
    const llama = join(bin, 'llama-server');
    writeFileSync(llama, `#!${process.execPath}\nsetInterval(() => undefined, 1000)\n`);
    chmodSync(llama, 0o755);
    const env = {
      PATH: bin,
      FLM_MODEL_PATH: join(paths.data, 'flm-models'),
      HF_HUB_CACHE: join(paths.data, 'hf-cache'),
    };
    const config = testConfig();
    const store = new MemoryConfigStore(config);
    const control = new EngineControl({
      store,
      paths,
      env,
      capabilities: async () => NO_CAPABILITIES,
      installed: async (ids) => new Map(ids.map((id) => [id, false])),
      create: () => new FakeEngine(),
    });
    const gw = await startGateway({ config, store, paths, env, engineControl: control });
    try {
      const started = performance.now();
      const response = await fetch(`${gw.url}/v1/engines`, { headers: controlHeaders(paths) });
      const elapsedMs = performance.now() - started;
      assert.equal(response.status, 200);
      assert.ok(elapsedMs < 500, `status took ${String(elapsedMs)} ms`);
      const body = await json(response);
      const engines = body['engines'] as { id: string; version?: string | null }[];
      assert.equal('version' in (engines.find((entry) => entry.id === 'llama-vulkan') ?? {}), true);
      const models = body['models'] as {
        id: string;
        engine: string;
        family?: { id: string; label: string } | null;
        format?: { short: string; label: string } | null;
        measured?: unknown[];
      }[];
      const llamaModel = models.find(
        (entry) => entry.engine === 'llama-vulkan' && entry.id === 'd3-mini-q4_k_m',
      );
      assert.deepEqual(llamaModel?.family, { id: 'vllm-sr/d3-mini', label: 'd3 mini' });
      assert.deepEqual(llamaModel?.format, { short: 'Q4_K_M', label: '4-bit (Q4_K_M)' });
      assert.deepEqual(llamaModel?.measured, []);
    } finally {
      await gw.close();
    }
  });
});
