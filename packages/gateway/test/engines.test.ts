import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseConfig, type StrandsEngineConfig } from '../src/config.ts';
import {
  createEngine,
  serveArgs,
  strandsBinary,
  StrandsDeciderEngine,
  SystemOneRemoteEngine,
} from '../src/engines/index.ts';
import { tempPaths } from './helpers.ts';

const REQUEST = { state: 's', questions: { q: { type: 'noul' as const, instructions: 'i' } } };

function strandsConfig(extra: Record<string, unknown> = {}): StrandsEngineConfig {
  const config = parseConfig({
    engine: { type: 'strands-decider', startTimeoutSeconds: 10, ...extra },
  });
  assert.ok(config.engine.type === 'strands-decider');
  return config.engine;
}

describe('SystemOneRemoteEngine', () => {
  let server: Server;
  let url = '';
  let mode: 'ok' | 'error' | 'garbage' = 'ok';
  let auth: string | undefined;

  before(async () => {
    server = createServer((req, res) => {
      auth = req.headers.authorization;
      if (req.url === '/health') {
        res.end('{"status":"ok"}');
        return;
      }
      if (mode === 'error') {
        res.statusCode = 422;
        res.end('{"detail":"too long"}');
        return;
      }
      res.end(mode === 'garbage' ? 'not json' : '{"answers":{"q":{"type":"noul","noul":0.9}}}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  after(() => server.close());

  it('becomes ready, decides and sends its bearer token from the named env var', async () => {
    const engine = new SystemOneRemoteEngine(
      { type: 'systemone-remote', url, model: 'm', tokenEnv: 'REMOTE_TOKEN' },
      { REMOTE_TOKEN: 'secret' },
    );
    await engine.start();
    assert.equal(engine.health().state, 'ready');
    mode = 'ok';
    const res = await engine.decide(REQUEST, AbortSignal.timeout(2000));
    assert.equal(res.answers['q']?.type, 'noul');
    assert.equal(auth, 'Bearer secret');
  });

  it('marks itself failed on HTTP errors and bad JSON', async () => {
    const engine = new SystemOneRemoteEngine({ type: 'systemone-remote', url, model: 'm' });
    await engine.start();
    mode = 'error';
    await assert.rejects(engine.decide(REQUEST, AbortSignal.timeout(2000)), /HTTP 422/);
    assert.equal(engine.health().state, 'failed');
    mode = 'garbage';
    await assert.rejects(engine.decide(REQUEST, AbortSignal.timeout(2000)), /invalid JSON/);
    await engine.stop();
    assert.equal(engine.health().state, 'stopped');
  });

  it('fails start when there is no /health', async () => {
    const engine = new SystemOneRemoteEngine({
      type: 'systemone-remote',
      url: 'http://127.0.0.1:1',
      model: 'm',
    });
    await engine.start();
    assert.equal(engine.health().state, 'failed');
    await assert.rejects(engine.decide(REQUEST, AbortSignal.timeout(500)), /unreachable/);
  });
});

/** A stand-in `strands-decider` executable: serves /health and /v1/systemone on --port. */
function fakeBinary(path: string, crashFirst: boolean): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const marker = `${path}.ran`;
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(`${path}.argv`)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${String(crashFirst)} && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(3); }
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
require('node:http').createServer((req, res) => {
  res.end(req.url === '/health' ? '{"status":"ok","max_length":4096}' : '{"answers":{"q":{"type":"noul","noul":0.2}}}');
}).listen(port, '127.0.0.1');
`,
  );
  chmodSync(path, 0o755);
}

describe('StrandsDeciderEngine', () => {
  it('builds serve args from config only', () => {
    assert.deepEqual(
      serveArgs(strandsConfig({ device: 'cpu', extraArgs: ['--no-warmup'] }), 9000),
      [
        'serve',
        'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
        '--host',
        '127.0.0.1',
        '--port',
        '9000',
        '--device',
        'cpu',
        '--max-batch',
        '8',
        '--no-warmup',
      ],
    );
    assert.ok(!serveArgs(strandsConfig(), 1).includes('--device'));
    assert.ok(
      serveArgs(strandsConfig({ device: 'cpu' }), 1).includes('--no-warmup'),
      'no warmup on CPU',
    );
    assert.ok(!serveArgs(strandsConfig({ device: 'mlx' }), 1).includes('--no-warmup'));
    const optIn = serveArgs(strandsConfig({ device: 'cpu', extraArgs: ['--warmup'] }), 1);
    assert.ok(optIn.includes('--warmup') && !optIn.includes('--no-warmup'));
    assert.throws(() => strandsConfig({ extraArgs: ['; rm -rf /'] }), /invalid config/);
  });

  it('fails clearly when the engine is not installed', async () => {
    const engine = new StrandsDeciderEngine(strandsConfig(), tempPaths());
    await engine.start();
    assert.equal(engine.health().state, 'failed');
    assert.match(engine.health().detail ?? '', /engine install/);
    await assert.rejects(engine.decide(REQUEST, AbortSignal.timeout(100)), /engine failed/);
  });

  it('spawns, waits for health, decides, restarts after a crash and stops', async () => {
    const paths = tempPaths();
    const binary = strandsBinary(paths);
    fakeBinary(binary, true);
    const engine = createEngine(strandsConfig({ device: 'cpu' }), paths);
    await engine.start();
    for (let i = 0; i < 100 && engine.health().state !== 'ready'; i++) {
      await sleep(100);
    }
    assert.equal(engine.health().state, 'ready');
    assert.equal(engine.health().maxLength, 4096);
    const res = await engine.decide(REQUEST, AbortSignal.timeout(2000));
    assert.equal(res.answers['q']?.type, 'noul');
    assert.equal(
      readFileSync(`${binary}.argv`, 'utf8').trim().split('\n').length,
      2,
      'restarted once',
    );
    await engine.stop();
    assert.equal(engine.health().state, 'stopped');
  });

  it('attaches to a configured URL without spawning', async () => {
    const server = createServer((_req, res) => res.end('{"status":"ok"}'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const engine = new StrandsDeciderEngine(strandsConfig({ url }), tempPaths());
      await engine.start();
      assert.equal(engine.health().state, 'ready');
      await engine.stop();
    } finally {
      server.close();
    }
  });
});
