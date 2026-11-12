import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { GatewayClient, loopbackUrl, trimTrailingSlashes } from '../src/index.ts';

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    assert.equal(trimTrailingSlashes('http://h:1/v1///'), 'http://h:1/v1');
    assert.equal(trimTrailingSlashes('http://h:1'), 'http://h:1');
    assert.equal(trimTrailingSlashes('///'), '');
    assert.equal(trimTrailingSlashes(''), '');
  });

  it('stays linear on a long run of slashes', () => {
    const value = `${'/'.repeat(200_000)}x`;
    assert.equal(trimTrailingSlashes(value), value);
  });
});

describe('GatewayClient', () => {
  let server: Server;
  let redirectServer: Server;
  let url = '';
  let redirectUrl = '';
  let lastAuth: string | undefined;
  let lastControl: string | string[] | undefined;
  let redirectMode = false;
  let redirected = 0;

  before(async () => {
    redirectServer = createServer((_req, res) => {
      redirected += 1;
      res.end('{}');
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    redirectUrl = `http://127.0.0.1:${String((redirectServer.address() as AddressInfo).port)}`;
    server = createServer((req, res) => {
      lastAuth = req.headers.authorization;
      lastControl = req.headers['x-local-decider-control'];
      if (redirectMode && (req.url === '/health' || req.url?.startsWith('/v1/decide/'))) {
        res.statusCode = 302;
        res.setHeader('location', `${redirectUrl}/hit`);
        res.end();
        return;
      }
      if (req.url === '/slow') {
        return;
      }
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/v1/outcomes') {
        res.end('{}');
        return;
      }
      if (req.url === '/v1/engines') {
        res.setHeader('content-type', 'application/json');
        res.end('{"engines":[],"models":[]}');
        return;
      }
      if (req.url === '/v1/engine') {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end('{"error":"unknown model"}');
        return;
      }
      res.statusCode = 500;
      res.end('{"error":"boom"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
    redirectServer.closeAllConnections();
    redirectServer.close();
  });

  it('returns parsed JSON and sends the bearer token', async () => {
    const client = new GatewayClient({ baseUrl: `${url}/`, token: 't0k', controlToken: 'control' });
    assert.deepEqual(await client.health(), { status: 'ok' });
    assert.equal(lastAuth, 'Bearer t0k');
    assert.equal(lastControl, 'control');
    assert.equal(await client.reportOutcome('d1', 'allow'), true);
  });

  it('fails open (null) on HTTP errors', async () => {
    const client = new GatewayClient({ baseUrl: url });
    assert.equal(await client.decide('permission', { harness: 'cli', input: {} }), null);
    assert.equal(lastAuth, undefined);
  });

  it('lists engines and preserves selection error status and body', async () => {
    const client = new GatewayClient({ baseUrl: url });
    assert.deepEqual(await client.engines(), { engines: [], models: [] });
    assert.deepEqual(await client.selectEngine({ engine: 'openai-compatible', model: 'missing' }), {
      status: 400,
      body: { error: 'unknown model' },
    });
  });

  it('fails open on timeouts and refused connections', async () => {
    const slow = new GatewayClient({ baseUrl: `${url}/slow#`, timeoutMs: 50 });
    assert.equal(await slow.health(), null);
    const down = new GatewayClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    assert.equal(await down.health(), null);
  });

  it('sends the control token only to loopback', async () => {
    let headers = new Headers();
    const client = new GatewayClient({
      baseUrl: 'https://example.test',
      controlToken: 'control',
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers);
        return Response.json({ status: 'ok' });
      },
    });
    assert.deepEqual(await client.health(), { status: 'ok' });
    assert.equal(headers.get('x-local-decider-control'), null);
  });

  it('refuses redirects without contacting a second loopback server', async () => {
    const client = new GatewayClient({ baseUrl: url });
    redirected = 0;
    redirectMode = true;
    try {
      assert.equal(await client.health(), null);
      assert.equal(await client.decide('permission', { harness: 'cli', input: {} }), null);
      assert.equal(redirected, 0);
    } finally {
      redirectMode = false;
    }
  });
});

describe('tokenAllowed', () => {
  it('allows https and loopback, refuses plain http to other hosts', async () => {
    const { tokenAllowed } = await import('../src/client.ts');
    assert.equal(tokenAllowed('https://gw.example:8765'), true);
    assert.equal(tokenAllowed('http://127.0.0.1:8765'), true);
    assert.equal(tokenAllowed('http://localhost:8765'), true);
    assert.equal(tokenAllowed('http://[::1]:8765'), true);
    assert.equal(tokenAllowed('http://127.8.9.10:8765'), true);
    assert.equal(tokenAllowed('http://127.evil.example:8765'), false);
    assert.equal(tokenAllowed('http://192.168.1.10:8765'), false);
    assert.equal(tokenAllowed('not a url'), false);
  });
});

describe('loopbackUrl', () => {
  it('accepts loopback hosts but rejects lookalike names and invalid URLs', () => {
    for (const url of [
      'http://127.0.0.1:1',
      'http://127.9.9.9',
      'http://localhost',
      'http://[::1]:8765',
    ]) {
      assert.equal(loopbackUrl(url), true, url);
    }
    for (const url of [
      'http://127.0.0.1.evil.test',
      'http://localhost.evil.test',
      'https://example.com',
      'not a url',
    ]) {
      assert.equal(loopbackUrl(url), false, url);
    }
  });
});
