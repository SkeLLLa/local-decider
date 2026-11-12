import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readControlToken, readReportToken } from '../server/deps.ts';
import { createGateway } from '../shared/gateway.ts';
import { bearerAllowed, loopbackUrl, normaliseBaseUrl, originOf } from '../shared/url.ts';
import { response, tempDir } from './fakes.ts';

function gatewayWithPin(tokenOrigin: string | undefined): {
  gateway: ReturnType<typeof createGateway>;
  headers: () => Headers;
} {
  let headers = new Headers();
  const gateway = createGateway({
    baseUrl: 'https://gw.example/path',
    token: 'bearer-secret',
    tokenOrigin,
    fetch: async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ status: 'ok' });
    },
  });
  return { gateway, headers: () => headers };
}

describe('normaliseBaseUrl', () => {
  it('accepts http(s) URLs and strips trailing slashes', () => {
    assert.equal(normaliseBaseUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');
    assert.equal(
      normaliseBaseUrl(' HTTPS://Decider.example/api// '),
      'https://decider.example/api',
    );
    assert.equal(normaliseBaseUrl('http://[::1]:8765'), 'http://[::1]:8765');
  });

  it('defaults an empty value', () => {
    assert.equal(normaliseBaseUrl(''), 'http://127.0.0.1:8765');
    assert.equal(normaliseBaseUrl(undefined), 'http://127.0.0.1:8765');
  });

  it('reads the report token with gateway config path precedence', () => {
    const root = tempDir('paseo-token');
    const explicit = join(root, 'explicit');
    const xdg = join(root, 'xdg', 'local-decider');
    mkdirSync(explicit, { recursive: true });
    mkdirSync(xdg, { recursive: true });
    const explicitToken = 'E'.repeat(43);
    const xdgToken = 'X'.repeat(43);
    writeFileSync(join(explicit, 'report-token'), explicitToken);
    writeFileSync(join(xdg, 'report-token'), xdgToken);
    writeFileSync(join(explicit, 'control-token'), 'C'.repeat(43));
    assert.equal(
      readReportToken({ LOCAL_DECIDER_CONFIG_DIR: explicit, XDG_CONFIG_HOME: join(root, 'xdg') }),
      explicitToken,
    );
    assert.equal(readReportToken({ XDG_CONFIG_HOME: join(root, 'xdg') }), xdgToken);
    assert.equal(readReportToken({ LOCAL_DECIDER_CONFIG_DIR: join(root, 'missing') }), undefined);
    assert.equal(
      readControlToken({ LOCAL_DECIDER_CONFIG_DIR: explicit, XDG_CONFIG_HOME: join(root, 'xdg') }),
      'C'.repeat(43),
    );
    writeFileSync(join(explicit, 'control-token'), 'truncated');
    assert.equal(readControlToken({ LOCAL_DECIDER_CONFIG_DIR: explicit }), undefined);
    for (const invalid of ['', 'truncated', `${'P'.repeat(43)}=`]) {
      writeFileSync(join(explicit, 'control-token'), invalid);
      assert.equal(readControlToken({ LOCAL_DECIDER_CONFIG_DIR: explicit }), undefined);
    }
  });

  it('rejects other schemes, credentials, queries and bad ports', () => {
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://user:pw@host',
      'http://host/?q=1',
      'http://host#x',
      'http://host:99999',
      'not a url',
    ]) {
      assert.equal(normaliseBaseUrl(bad), null, bad);
    }
  });
});

describe('createGateway (fail open)', () => {
  let server: Server;
  let redirectServer: Server;
  let url = '';
  let redirectUrl = '';
  let redirected = 0;
  const seen: {
    path: string;
    auth: string | undefined;
    report: string | string[] | undefined;
    control: string | string[] | undefined;
    body: string;
  }[] = [];

  before(async () => {
    redirectServer = createServer((_req, res) => {
      redirected += 1;
      res.end('{}');
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    redirectUrl = `http://127.0.0.1:${(redirectServer.address() as AddressInfo).port}`;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          auth: req.headers.authorization,
          report: req.headers['x-local-decider-report'],
          control: req.headers['x-local-decider-control'],
          body,
        });
        const routes: Record<string, () => void> = {
          '/v1/decide/turn-outcome': () => res.end(JSON.stringify(response())),
          '/v1/decide/garbage': () => res.end('{not json'),
          '/v1/decide/wrong-shape': () => res.end('{"hello":1}'),
          '/v1/decide/slow': () => {},
          '/v1/decide/redirect': () => {
            res.statusCode = 302;
            res.setHeader('location', `${redirectUrl}/hit`);
            res.end();
          },
          '/v1/decide/unauthorised': () => {
            res.statusCode = 401;
            res.end('{}');
          },
          '/health': () => res.end('{"status":"ok","model":"m","p50Ms":90}'),
          '/v1/outcomes': () => res.end('{}'),
        };
        const route = routes[req.url ?? ''];
        if (route === undefined) {
          res.statusCode = 500;
          res.end('{"error":"boom"}');
          return;
        }
        route();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    redirectServer.closeAllConnections();
    redirectServer.close();
  });

  it('returns the decision and sends the request body', async () => {
    const gw = createGateway({ baseUrl: url });
    const res = await gw?.decide('turn-outcome', {
      harness: 'paseo',
      sessionId: 'a1',
      input: { task: 't' },
    });
    assert.equal(res?.decisionId, 'd-1');
    const last = seen.at(-1);
    assert.deepEqual(JSON.parse(last?.body ?? ''), {
      harness: 'paseo',
      sessionId: 'a1',
      input: { task: 't' },
    });
    assert.equal(last?.auth, undefined);
  });

  it('returns null on 5xx, bad JSON, a wrong shape and timeouts', async () => {
    const gw = createGateway({ baseUrl: url, timeoutMs: 200 });
    const req = { harness: 'paseo' as const, input: {} };
    assert.equal(await gw?.decide('unknown', req), null);
    assert.equal(await gw?.decide('garbage', req), null);
    assert.equal(await gw?.decide('wrong-shape', req), null);
    const started = Date.now();
    assert.equal(await gw?.decide('slow', req), null);
    assert.ok(Date.now() - started < 2000);
  });

  it('honours a caller abort signal', async () => {
    const gw = createGateway({ baseUrl: url, timeoutMs: 10_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const res = await gw?.decide(
      'slow',
      { harness: 'paseo', input: {} },
      { signal: controller.signal },
    );
    assert.equal(res, null);
  });

  it('refuses redirects and notifies the gateway source after a 401', async () => {
    const req = { harness: 'paseo' as const, input: {} };
    const gw = createGateway({ baseUrl: url });
    redirected = 0;
    assert.equal(await gw?.decide('redirect', req), null);
    assert.equal(redirected, 0);
    let unauthorised = 0;
    const protectedGateway = createGateway({
      baseUrl: url,
      onUnauthorised: () => {
        unauthorised += 1;
      },
    });
    assert.equal(await protectedGateway?.decide('unauthorised', req), null);
    assert.equal(unauthorised, 1);
  });

  it('sets redirect:error on injected fetches', async () => {
    let redirect: RequestInit['redirect'];
    const gw = createGateway({
      baseUrl: url,
      fetch: async (_input, init) => {
        redirect = init?.redirect;
        return Response.json({ status: 'ok' });
      },
    });
    await gw?.health();
    assert.equal(redirect, 'error');
  });

  it('returns null when nothing listens', async () => {
    const gw = createGateway({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    assert.equal(await gw?.health(), null);
    assert.equal(await gw?.reportOutcome('d', 'allow', 'user'), false);
  });

  it('sends the bearer token to loopback and local tokens to every loopback call', async () => {
    const gw = createGateway({ baseUrl: url, token: 'sekrit', reportToken: 'report-secret' });
    const withControl = createGateway({
      baseUrl: url,
      token: 'sekrit',
      reportToken: 'report-secret',
      controlToken: 'control-secret',
    });
    assert.deepEqual(await gw?.health(), { status: 'ok', model: 'm', p50Ms: 90 });
    assert.equal(gw?.bearer, true);
    assert.equal(seen.at(-1)?.auth, 'Bearer sekrit');
    assert.equal(seen.at(-1)?.control, undefined);
    await withControl?.health();
    assert.equal(seen.at(-1)?.control, 'control-secret');
    assert.equal(await gw?.reportOutcome('d-1', 'allow', 'user'), true);
    assert.deepEqual(JSON.parse(seen.at(-1)?.body ?? ''), {
      decisionId: 'd-1',
      outcome: 'allow',
      source: 'user',
    });
    assert.equal(seen.at(-1)?.report, 'report-secret');
    assert.equal(await gw?.reportOutcome('d-2', 'deny', 'supervised'), true);
    assert.deepEqual(JSON.parse(seen.at(-1)?.body ?? ''), {
      decisionId: 'd-2',
      outcome: 'deny',
      source: 'supervised',
    });
  });

  it('sends the control token on every gateway method to loopback', async () => {
    const gw = createGateway({
      baseUrl: url,
      controlToken: 'control-secret',
      reportToken: 'report-secret',
    });
    const first = seen.length;
    await Promise.all([
      gw?.decide('turn-outcome', { harness: 'paseo', input: {} }),
      gw?.reportOutcome('d', 'allow', 'user'),
      gw?.reportUsage({
        decisionId: 'd',
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
      }),
      gw?.health(),
      gw?.engines(),
      gw?.stats(),
      gw?.selectEngine({ model: 'm' }),
      gw?.setSelectionMode('auto'),
      gw?.downloadModel({ engine: 'e', model: 'm' }),
      gw?.validateEngine('e'),
      gw?.saveEngineConnection({}),
      gw?.discoverServers({}),
      gw?.setPath('tools.flm', null),
      gw?.engineLoad('load'),
      gw?.setLifecycle({ lifecycle: 'lazy' }),
      gw?.setPolicyMode('permission', 'shadow'),
      gw?.policies(),
      gw?.setPolicyVariant('permission', 'base'),
      gw?.setPolicyThresholds('permission', {}),
      gw?.reloadPolicies(),
      gw?.config(),
      gw?.setRoutingPreset({ harness: 'paseo', preset: 'fast' }),
      gw?.policyPrompt('routing'),
      gw?.benchmark(),
      gw?.benchmarkStart({}),
      gw?.benchmarkCancel(),
    ]);
    const requests = seen.slice(first);
    assert.equal(requests.length, 26);
    assert.ok(requests.every((request) => request.control === 'control-secret'));
  });

  it('sends no local tokens to an https gateway, even when its origin is pinned', async () => {
    let sentHeaders = new Headers();
    const gw = createGateway({
      baseUrl: 'https://gateway.example',
      reportToken: 'private-report-token',
      controlToken: 'private-control-token',
      token: 'bearer-secret',
      tokenOrigin: 'https://gateway.example',
      fetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
    });
    assert.equal(await gw?.reportOutcome('d', 'allow', 'user'), true);
    assert.equal(sentHeaders.get('x-local-decider-report'), null);
    assert.equal(sentHeaders.get('x-local-decider-control'), null);
    assert.equal(sentHeaders.get('authorization'), 'Bearer bearer-secret');
    assert.equal(gw?.bearer, true);
  });

  it('does not send local tokens to a plain HTTP remote gateway', async () => {
    let sentHeaders = new Headers();
    const gw = createGateway({
      baseUrl: 'http://gateway.example',
      reportToken: 'private-report-token',
      controlToken: 'private-control-token',
      token: 'bearer-secret',
      tokenOrigin: 'https://gateway.example',
      fetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
    });
    await gw?.reportOutcome('d', 'allow', 'user');
    assert.equal(sentHeaders.get('x-local-decider-report'), null);
    assert.equal(sentHeaders.get('x-local-decider-control'), null);
    assert.equal(sentHeaders.get('authorization'), null);
    assert.equal(gw?.bearer, false);
  });

  it('pins the bearer to an exact https origin and reports whether it is sent', async () => {
    const unpinned = gatewayWithPin(undefined);
    await unpinned.gateway?.health();
    assert.equal(unpinned.gateway?.bearer, false);
    assert.equal(unpinned.headers().get('authorization'), null);
    const pinned = gatewayWithPin('https://GW.example/path/');
    await pinned.gateway?.health();
    assert.equal(pinned.gateway?.bearer, true);
    assert.equal(pinned.headers().get('authorization'), 'Bearer bearer-secret');
  });

  it('is null for an unusable URL', () => {
    assert.equal(createGateway({ baseUrl: 'ftp://x' }), null);
  });

  it('never throws when fetch itself throws', async () => {
    const gw = createGateway({
      baseUrl: url,
      fetch: async () => {
        throw new TypeError('network down');
      },
    });
    assert.equal(await gw?.stats(), null);
  });
});

function recording(
  status: number,
  body: unknown,
): {
  gateway: ReturnType<typeof createGateway>;
  sent: { url: string; body: unknown; type: string | undefined }[];
} {
  const sent: { url: string; body: unknown; type: string | undefined }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, body: JSON.parse(init.body as string), type: headers['content-type'] });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { gateway: createGateway({ fetch }), sent };
}

describe('createGateway engine calls', () => {
  it('omits device auto so the gateway keeps its own, and sends JSON', async () => {
    const { gateway, sent } = recording(200, { state: 'starting' });
    assert.deepEqual(await gateway?.selectEngine({ model: 'm', device: 'auto' }), {
      ok: true,
      body: { state: 'starting' },
    });
    await gateway?.selectEngine({ engine: 'fastflowlm', model: 'd3:nano', device: 'cpu' });
    assert.deepEqual(
      sent.map((s) => s.body),
      [{ model: 'm' }, { engine: 'fastflowlm', model: 'd3:nano', device: 'cpu' }],
    );
    assert.ok(sent.every((s) => s.type === 'application/json'));
  });

  it('posts the selection mode to its own endpoint', async () => {
    const { gateway, sent } = recording(200, { mode: 'auto' });
    await gateway?.setSelectionMode('auto');
    assert.deepEqual(sent, [
      { url: sent[0]?.url ?? '', body: { mode: 'auto' }, type: 'application/json' },
    ]);
    assert.match(sent[0]?.url ?? '', /\/v1\/engine\/mode$/);
  });

  it('sends the family with the selection mode only when given', async () => {
    const { gateway, sent } = recording(200, {});
    await gateway?.setSelectionMode('auto', 'vllm-sr/d3-lite');
    await gateway?.setSelectionMode('manual');
    assert.deepEqual(
      sent.map((s) => s.body),
      [{ mode: 'auto', family: 'vllm-sr/d3-lite' }, { mode: 'manual' }],
    );
  });

  it('reads, starts and cancels a benchmark with the right paths, methods and timeouts', async () => {
    const seen: { url: string; method: string | undefined; body: unknown }[] = [];
    const gateway = createGateway({
      controlToken: 'control-secret',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({
          url: new URL(url).pathname,
          method: init.method,
          body: init.body === undefined ? undefined : JSON.parse(init.body as string),
        });
        return new Response(JSON.stringify({ state: 'running' }), { status: 202 });
      }) as typeof globalThis.fetch,
    });
    assert.deepEqual(await gateway?.benchmark(), { state: 'running' });
    await gateway?.benchmarkStart({ scope: 'family', family: 'f', client: 'cli' });
    await gateway?.benchmarkStart({});
    await gateway?.benchmarkCancel();
    assert.deepEqual(
      seen.map((s) => [s.method, s.url, s.body]),
      [
        ['GET', '/v1/benchmark', undefined],
        ['POST', '/v1/benchmark', { scope: 'family', family: 'f', client: 'paseo' }],
        ['POST', '/v1/benchmark', { client: 'paseo' }],
        ['POST', '/v1/benchmark/cancel', {}],
      ],
    );
  });

  it('uses 3 s to read a benchmark and 10 s to start or cancel one', async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) => {
      timeouts.push(ms);
      return real(ms);
    };
    try {
      const gateway = createGateway({
        fetch: (async () => Response.json({})) as unknown as typeof globalThis.fetch,
      });
      await gateway?.benchmark();
      await gateway?.benchmarkStart({});
      await gateway?.benchmarkCancel();
    } finally {
      AbortSignal.timeout = real;
    }
    assert.deepEqual(timeouts, [3000, 10_000, 10_000]);
  });

  it('reports a benchmark 409 or 400 as the gateway error message', async () => {
    const busy = recording(409, { error: 'a benchmark is already running' });
    assert.deepEqual(await busy.gateway?.benchmarkStart({}), {
      ok: false,
      error: 'a benchmark is already running',
    });
    const none = recording(409, { error: 'no benchmark is running' });
    assert.deepEqual(await none.gateway?.benchmarkCancel(), {
      ok: false,
      error: 'no benchmark is running',
    });
    const bad = recording(400, { error: 'unknown model family "x"' });
    assert.deepEqual(await bad.gateway?.setSelectionMode('auto', 'x'), {
      ok: false,
      error: 'unknown model family "x"',
    });
  });

  it('posts downloads, validation, paths, load and lifecycle to their endpoints', async () => {
    const { gateway, sent } = recording(202, { download: { id: 'dl-1' } });
    await gateway?.downloadModel({ engine: 'fastflowlm', model: 'd3:mini' });
    await gateway?.validateEngine('fastflowlm');
    await gateway?.setPath('tools.flm', null);
    await gateway?.engineLoad('load');
    await gateway?.engineLoad('unload');
    await gateway?.setLifecycle({ lifecycle: 'lazy', idleUnloadMinutes: 30 });
    assert.deepEqual(
      sent.map((s) => [new URL(s.url).pathname, s.body]),
      [
        ['/v1/models/download', { engine: 'fastflowlm', model: 'd3:mini' }],
        ['/v1/engines/validate', { engine: 'fastflowlm' }],
        ['/v1/paths', { key: 'tools.flm', value: null }],
        ['/v1/engine/load', {}],
        ['/v1/engine/unload', {}],
        ['/v1/engine/lifecycle', { lifecycle: 'lazy', idleUnloadMinutes: 30 }],
      ],
    );
    assert.ok(sent.every((s) => s.type === 'application/json'));
  });

  it("reports the gateway's error message, or the status without one", async () => {
    const { gateway } = recording(409, { error: 'd3:mini needs ~12 GB' });
    assert.deepEqual(await gateway?.selectEngine({ model: 'x' }), {
      ok: false,
      error: 'd3:mini needs ~12 GB',
    });
    const bare = recording(500, 'boom');
    assert.deepEqual(await bare.gateway?.downloadModel({ engine: 'e', model: 'm' }), {
      ok: false,
      error: 'HTTP 500',
    });
  });

  it('reports an unreachable gateway without throwing', async () => {
    const gateway = createGateway({
      fetch: async () => {
        throw new TypeError('network down');
      },
    });
    assert.deepEqual(await gateway?.validateEngine('fastflowlm'), {
      ok: false,
      error: 'network down',
    });
  });
});

describe('token URL scoping (plugin)', () => {
  it('classifies loopback hosts', () => {
    for (const yes of [
      'http://127.0.0.1:1',
      'http://127.9.9.9',
      'http://localhost',
      'http://[::1]:8765',
    ]) {
      assert.equal(loopbackUrl(yes), true, yes);
    }
    for (const no of [
      'http://127.0.0.1.evil.test',
      'http://localhost.evil.test',
      'https://example.com',
      'not a url',
    ]) {
      assert.equal(loopbackUrl(no), false, no);
    }
  });

  it('derives validated origins without defaulting or normalising false negatives', () => {
    assert.equal(originOf(''), null);
    assert.equal(originOf('   '), null);
    for (const bad of ['https://u:p@h', 'https://h\\x', 'https://h:99999', 'https://h\n/path']) {
      assert.equal(originOf(bad), null, bad);
    }
    assert.equal(originOf('HTTPS://GW.Example:8443/x/'), 'https://gw.example:8443');
    assert.equal(originOf('  HTTPS://GW.Example:8443/x/\n '), 'https://gw.example:8443');
    assert.equal(originOf('https://[2001:db8::1]:8443'), 'https://[2001:db8::1]:8443');
    assert.equal(bearerAllowed('http://127.0.0.1:1', undefined), true);
    assert.equal(bearerAllowed('https://gw.example', undefined), false);
    assert.equal(bearerAllowed('https://gw.example/path', 'https://gw.example'), true);
    assert.equal(bearerAllowed('https://gw.example', 'HTTPS://GW.EXAMPLE/'), true);
    assert.equal(bearerAllowed('https://gw.example', 'https://elsewhere'), false);
    assert.equal(bearerAllowed('http://gw.example', 'http://gw.example'), false);
    assert.equal(bearerAllowed('https://[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'), true);
    assert.equal(bearerAllowed('https://gw.example.', 'https://gw.example'), false);
    assert.equal(bearerAllowed('https://h', 'https://h:443'), false);
    assert.equal(bearerAllowed('invalid', 'invalid'), false);
    assert.equal(bearerAllowed('https://h', ''), false);
  });
});
