import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { GatewayClient } from '../src/index.ts';

describe('GatewayClient', () => {
  let server: Server;
  let url = '';
  let lastAuth: string | undefined;

  before(async () => {
    server = createServer((req, res) => {
      lastAuth = req.headers.authorization;
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
      res.statusCode = 500;
      res.end('{"error":"boom"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('returns parsed JSON and sends the bearer token', async () => {
    const client = new GatewayClient({ baseUrl: `${url}/`, token: 't0k' });
    assert.deepEqual(await client.health(), { status: 'ok' });
    assert.equal(lastAuth, 'Bearer t0k');
    assert.equal(await client.reportOutcome('d1', 'allow'), true);
  });

  it('fails open (null) on HTTP errors', async () => {
    const client = new GatewayClient({ baseUrl: url });
    assert.equal(await client.decide('permission', { harness: 'cli', input: {} }), null);
    assert.equal(lastAuth, undefined);
  });

  it('fails open on timeouts and refused connections', async () => {
    const slow = new GatewayClient({ baseUrl: `${url}/slow#`, timeoutMs: 50 });
    assert.equal(await slow.health(), null);
    const down = new GatewayClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    assert.equal(await down.health(), null);
  });
});

describe('tokenAllowed', () => {
  it('allows https and loopback, refuses plain http to other hosts', async () => {
    const { tokenAllowed } = await import('../src/client.ts');
    assert.equal(tokenAllowed('https://gw.example:8765'), true);
    assert.equal(tokenAllowed('http://127.0.0.1:8765'), true);
    assert.equal(tokenAllowed('http://localhost:8765'), true);
    assert.equal(tokenAllowed('http://[::1]:8765'), true);
    assert.equal(tokenAllowed('http://192.168.1.10:8765'), false);
    assert.equal(tokenAllowed('not a url'), false);
  });
});
