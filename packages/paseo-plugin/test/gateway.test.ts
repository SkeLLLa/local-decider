import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readReportToken } from '../server/deps.ts';
import { createGateway } from '../shared/gateway.ts';
import { normaliseBaseUrl } from '../shared/url.ts';
import { response } from './fakes.ts';

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
    const root = mkdtempSync(join(tmpdir(), 'ld-paseo-token-'));
    const explicit = join(root, 'explicit');
    const xdg = join(root, 'xdg', 'local-decider');
    mkdirSync(explicit, { recursive: true });
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(explicit, 'report-token'), 'explicit-token');
    writeFileSync(join(xdg, 'report-token'), 'xdg-token');
    assert.equal(
      readReportToken({ LOCAL_DECIDER_CONFIG_DIR: explicit, XDG_CONFIG_HOME: join(root, 'xdg') }),
      'explicit-token',
    );
    assert.equal(readReportToken({ XDG_CONFIG_HOME: join(root, 'xdg') }), 'xdg-token');
    assert.equal(readReportToken({ LOCAL_DECIDER_CONFIG_DIR: join(root, 'missing') }), undefined);
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
  let url = '';
  const seen: {
    path: string;
    auth: string | undefined;
    report: string | string[] | undefined;
    body: string;
  }[] = [];

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          auth: req.headers.authorization,
          report: req.headers['x-local-decider-report'],
          body,
        });
        const routes: Record<string, () => void> = {
          '/v1/decide/turn-outcome': () => res.end(JSON.stringify(response())),
          '/v1/decide/garbage': () => res.end('{not json'),
          '/v1/decide/wrong-shape': () => res.end('{"hello":1}'),
          '/v1/decide/slow': () => {},
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

  it('returns null when nothing listens', async () => {
    const gw = createGateway({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    assert.equal(await gw?.health(), null);
    assert.equal(await gw?.reportOutcome('d', 'allow', 'user'), false);
  });

  it('sends the bearer token when set', async () => {
    const gw = createGateway({ baseUrl: url, token: 'sekrit', reportToken: 'report-secret' });
    assert.deepEqual(await gw?.health(), { status: 'ok', model: 'm', p50Ms: 90 });
    assert.equal(seen.at(-1)?.auth, 'Bearer sekrit');
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

  it('does not send the report token to a remote plain HTTP gateway', async () => {
    let sentHeaders = new Headers();
    const gw = createGateway({
      baseUrl: 'http://gateway.example',
      reportToken: 'private-report-token',
      fetch: async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      },
    });
    assert.equal(await gw?.reportOutcome('d', 'allow', 'user'), true);
    assert.equal(sentHeaders.get('x-local-decider-report'), null);
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

describe('tokenAllowed (plugin)', () => {
  it('allows https and loopback, refuses plain http to other hosts', async () => {
    const { tokenAllowed } = await import('../shared/url.ts');
    assert.equal(tokenAllowed('https://gw.example:8765'), true);
    assert.equal(tokenAllowed('http://127.0.0.1:8765'), true);
    assert.equal(tokenAllowed('http://localhost:8765'), true);
    assert.equal(tokenAllowed('http://10.0.0.5:8765'), false);
  });
});
