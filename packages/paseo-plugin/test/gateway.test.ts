import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

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
  const seen: { path: string; auth: string | undefined; body: string }[] = [];

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', auth: req.headers.authorization, body });
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
    const gw = createGateway({ baseUrl: url, token: 'sekrit' });
    assert.deepEqual(await gw?.health(), { status: 'ok', model: 'm', p50Ms: 90 });
    assert.equal(seen.at(-1)?.auth, 'Bearer sekrit');
    assert.equal(await gw?.reportOutcome('d-1', 'allow', 'user'), true);
    assert.deepEqual(JSON.parse(seen.at(-1)?.body ?? ''), {
      decisionId: 'd-1',
      outcome: 'allow',
      source: 'user',
    });
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
): { gateway: ReturnType<typeof createGateway>; sent: unknown[] } {
  const sent: unknown[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { gateway: createGateway({ fetch }), sent };
}

describe('createGateway.selectEngine', () => {
  it('omits device auto so the gateway keeps its own', async () => {
    const { gateway, sent } = recording(200, {});
    assert.deepEqual(await gateway?.selectEngine({ model: 'm', device: 'auto' }), { ok: true });
    await gateway?.selectEngine({ model: 'm', device: 'cpu' });
    assert.deepEqual(sent, [{ model: 'm' }, { model: 'm', device: 'cpu' }]);
  });

  it('reports the gateway error', async () => {
    const { gateway } = recording(400, { error: 'unknown model "x"' });
    assert.deepEqual(await gateway?.selectEngine({ model: 'x', device: 'auto' }), {
      ok: false,
      error: 'HTTP 400: unknown model "x"',
    });
  });
});
