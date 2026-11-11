import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryConfigStore } from '../src/config-file.ts';
import { parseConfig, type EngineConfig } from '../src/config.ts';
import type { Decider } from '../src/decider.ts';
import { EngineControl, EngineSwitchError } from '../src/engine-control.ts';
import { ModelDiscovery } from '../src/engine-discovery.ts';
import { parseDiscoverRequest, safeModelIds, ServerProbe } from '../src/engine-probe.ts';
import type { Engine, EngineHealth } from '../src/engines/types.ts';
import { settingsHandler } from '../src/settings-routes.ts';
import { stubCapabilities, tempPaths } from './helpers.ts';

type Responder = (url: string, init: RequestInit | undefined) => Promise<Response>;

function counting(responder: Responder): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      urls.push(url);
      return responder(url, init);
    },
  };
}

const LMSTUDIO = {
  data: [
    { id: 'qwen/qwen3-4b', type: 'llm', state: 'loaded' },
    { id: 'embed-x', type: 'embeddings', state: 'not-loaded' },
  ],
};

const lmStudioOnly: Responder = (url) =>
  url === 'http://127.0.0.1:1234/api/v0/models'
    ? Promise.resolve(Response.json(LMSTUDIO))
    : Promise.reject(new TypeError('fetch failed'));

const suggest = { kind: 'suggestions' } as const;

describe('safeModelIds', () => {
  it('bounds length, charset, count and duplicates', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `m${String(i)}` }));
    const ids = safeModelIds([
      { id: 'ok/model:1' },
      { id: 'ok/model:1' },
      { id: 'a'.repeat(201) },
      { id: '-lead' },
      { id: 'sp ace' },
      { id: 'new\nline' },
      { id: '<script>' },
      { id: 4 },
      null,
      ...many,
    ]);
    assert.equal(ids[0], 'ok/model:1');
    assert.equal(ids.length, 200);
    assert.ok(ids.every((id) => /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(id)));
  });
});

describe('parseDiscoverRequest', () => {
  it('treats an empty body as suggestions and validates {engine, url}', () => {
    assert.deepEqual(parseDiscoverRequest(undefined), suggest);
    assert.deepEqual(parseDiscoverRequest({}), suggest);
    assert.deepEqual(parseDiscoverRequest({ engine: 'lmstudio', url: 'http://h:1/v1/' }), {
      kind: 'url',
      engine: 'lmstudio',
      url: 'http://h:1/v1',
    });
    for (const bad of [
      { engine: 'lmstudio' },
      { engine: 'fastflowlm', url: 'http://h/v1' },
      { engine: 'lmstudio', url: 'http://u:p@h/v1' },
      { engine: 'lmstudio', url: 'http://h/v1?k=1' },
      { engine: 'lmstudio', url: 'http://h/v1', token: 'sk-secret' },
      'sk-secret',
    ]) {
      assert.throws(
        () => parseDiscoverRequest(bad),
        (error: unknown) => error instanceof Error && !error.message.includes('secret'),
      );
    }
  });
});

describe('ServerProbe suggestions', () => {
  it('finds an unconfigured LM Studio by its native API, with usable models only', async () => {
    const { fetch, urls } = counting(lmStudioOnly);
    const result = (await new ServerProbe({ fetch }).discover(suggest)) as {
      suggestions: {
        url: string;
        kind: string;
        state: string;
        models: string[];
        reason?: string;
      }[];
    };
    assert.equal(result.suggestions.length, 3);
    const [lm, ollama, llama] = result.suggestions;
    assert.deepEqual(lm, {
      url: 'http://127.0.0.1:1234/v1',
      kind: 'lmstudio',
      state: 'reachable',
      models: ['qwen/qwen3-4b'],
    });
    assert.equal(ollama?.url, 'http://127.0.0.1:11434/v1');
    assert.equal(ollama?.state, 'error');
    assert.equal(ollama?.reason, 'unreachable');
    assert.equal(llama?.state, 'error');
    assert.ok(urls.every((url) => url.startsWith('http://127.0.0.1:')));
  });

  it('does not call a server LM Studio just because of its port', async () => {
    const { fetch } = counting((url) =>
      Promise.resolve(
        url.endsWith('/api/v0/models')
          ? new Response('nope', { status: 404 })
          : Response.json({ data: [{ id: 'llama-3' }] }),
      ),
    );
    const result = (await new ServerProbe({ fetch }).discover(suggest)) as {
      suggestions: { kind: string; models: string[] }[];
    };
    assert.deepEqual(result.suggestions[0], {
      url: 'http://127.0.0.1:1234/v1',
      kind: 'openai-compatible',
      state: 'reachable',
      models: ['llama-3'],
    });
  });

  it('sends no credentials and never follows redirects', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const { fetch } = counting((_url, init) => {
      inits.push(init);
      return Promise.resolve(Response.json({ data: [] }));
    });
    await new ServerProbe({ fetch }).discover({
      kind: 'url',
      engine: 'openai-compatible',
      url: 'http://127.0.0.1:9/v1',
    });
    assert.equal(inits.length, 1);
    assert.equal(inits[0]?.redirect, 'error');
    assert.equal(new Headers(inits[0]?.headers).get('authorization'), null);
    assert.equal(inits[0]?.method, 'GET');
  });
});

describe('ServerProbe budget', () => {
  const cases: [string, Responder, string][] = [
    ['stopped', () => Promise.reject(new TypeError('fetch failed')), 'unreachable'],
    [
      'malformed',
      () => Promise.resolve(new Response('<html>', { status: 200 })),
      'not a JSON response',
    ],
    [
      'not a list',
      () => Promise.resolve(Response.json({ hello: 'secret-token-123' })),
      'not a JSON response',
    ],
    [
      'oversized',
      () => Promise.resolve(new Response('x'.repeat(300 * 1024))),
      'response too large',
    ],
    [
      'erroring',
      () => Promise.resolve(new Response('secret-token-123', { status: 503 })),
      'HTTP 503',
    ],
    [
      'redirecting',
      () => Promise.reject(new TypeError('fetch failed', { cause: 'redirect' })),
      'unreachable',
    ],
    ['hanging', () => new Promise<Response>(() => {}), 'timed out'],
  ];
  for (const [name, responder, reason] of cases) {
    it(`finishes a ${name} server within the deadline with a value-free reason`, async () => {
      const started = Date.now();
      const result = (await new ServerProbe({ fetch: counting(responder).fetch }).discover({
        kind: 'url',
        engine: 'openai-compatible',
        url: 'http://127.0.0.1:9/v1',
      })) as { server: { state: string; reason: string; models: string[] } };
      assert.ok(Date.now() - started < 1500);
      assert.equal(result.server.state, 'error');
      assert.equal(result.server.reason, reason);
      assert.deepEqual(result.server.models, []);
      assert.ok(!JSON.stringify(result).includes('secret-token'));
    });
  }

  it('answers the whole suggestion set within the deadline when every server hangs', async () => {
    const started = Date.now();
    await new ServerProbe({
      fetch: counting(() => new Promise<Response>(() => {})).fetch,
    }).discover(suggest);
    assert.ok(Date.now() - started < 1500);
  });
});

describe('ServerProbe cache', () => {
  it('caches hits and misses for 30 s, per normalized URL', async () => {
    let clock = 1000;
    const { fetch, urls } = counting(lmStudioOnly);
    const probe = new ServerProbe({ fetch, now: () => clock });
    await probe.discover(suggest);
    const first = urls.length;
    await probe.discover(suggest);
    clock += 29_000;
    await probe.discover(suggest);
    assert.equal(urls.length, first);
    clock += 2000;
    await probe.discover(suggest);
    assert.ok(urls.length > first);
  });

  it('shares one probe between concurrent calls', async () => {
    const { fetch, urls } = counting(lmStudioOnly);
    const probe = new ServerProbe({ fetch });
    await Promise.all([probe.discover(suggest), probe.discover(suggest), probe.discover(suggest)]);
    assert.equal(urls.filter((url) => url.includes(':1234/')).length, 1);
  });

  it('never reuses the models of another URL', async () => {
    const { fetch } = counting((url) =>
      Promise.resolve(Response.json({ data: [{ id: url.includes('one') ? 'a' : 'b' }] })),
    );
    const probe = new ServerProbe({ fetch });
    const models = async (url: string): Promise<string[]> =>
      (
        (await probe.discover({ kind: 'url', engine: 'openai-compatible', url })) as {
          server: { models: string[] };
        }
      ).server.models;
    assert.deepEqual(await models('http://one/v1'), ['a']);
    assert.deepEqual(await models('http://two/v1'), ['b']);
    assert.deepEqual(await models('http://one/v1'), ['a']);
  });
});

describe('background discovery', () => {
  it('kick launches no probe while the result is fresh or in flight', async () => {
    let clock = 0;
    const { fetch, urls } = counting(() => Promise.resolve(Response.json({ data: [{ id: 'a' }] })));
    const discovery = new ModelDiscovery({}, fetch, () => clock);
    const endpoint = { url: 'http://h/v1', model: 'm0' };
    discovery.kick('openai-compatible', endpoint);
    discovery.kick('openai-compatible', endpoint);
    await discovery.settled();
    assert.equal(urls.length, 1);
    discovery.kick('openai-compatible', endpoint);
    clock += 29_000;
    discovery.kick('openai-compatible', endpoint);
    await discovery.settled();
    assert.equal(urls.length, 1);
    clock += 2000;
    discovery.kick('openai-compatible', endpoint);
    await discovery.settled();
    assert.equal(urls.length, 2);
    const other = { url: 'http://other/v1', model: 'm0' };
    discovery.kick('openai-compatible', other);
    assert.deepEqual(discovery.models('openai-compatible', other), []);
  });
});

class StubEngine implements Engine {
  readonly id: string;
  readonly model: string;
  constructor(config: EngineConfig) {
    this.id = config.type;
    this.model = config.model;
  }
  async start(): Promise<void> {}
  health(): EngineHealth {
    return { state: 'ready', model: this.model };
  }
  async decide(): Promise<never> {
    throw new Error('not used');
  }
  async stop(): Promise<void> {}
}

function control(fetch: typeof globalThis.fetch, pathsEditable = true): EngineControl {
  return new EngineControl({
    store: new MemoryConfigStore(
      parseConfig({ engines: { 'openai-compatible': { url: 'http://h/v1', model: 'm0' } } }),
    ),
    paths: tempPaths(),
    env: { PATH: '' },
    capabilities: stubCapabilities,
    pathsEditable,
    totalMemory: 1e12,
    installed: async () => new Map(),
    create: (config) => new StubEngine(config),
    fetch,
  });
}

describe('EngineControl hot path and route', () => {
  it('repeated status calls launch no extra probes once discovery has run', async () => {
    const { fetch, urls } = counting(() => Promise.resolve(Response.json({ data: [{ id: 'a' }] })));
    const c = control(fetch);
    await c.status();
    await c.refreshDiscovery();
    const settled = urls.length;
    for (let i = 0; i < 5; i += 1) {
      await c.status();
      c.allowedModels();
    }
    await c.refreshDiscovery();
    assert.equal(urls.length, settled);
  });

  it('status does not wait for a hanging server', async () => {
    const c = control(() => new Promise<Response>(() => {}));
    const started = Date.now();
    await c.status();
    assert.ok(Date.now() - started < 500);
  });

  it('serves POST /v1/engines/discover, persists nothing and needs a loopback gateway', async () => {
    const route = settingsHandler('POST /v1/engines/discover', '/v1/engines/discover');
    assert.ok(route !== undefined);
    const decider = undefined as unknown as Decider;
    const c = control(counting(lmStudioOnly).fetch);
    const before = JSON.stringify(c.settings);
    const [status, body] = await route(undefined, c, decider);
    assert.equal(status, 200);
    assert.equal((body as { suggestions: unknown[] }).suggestions.length, 3);
    assert.equal(JSON.stringify(c.settings), before);
    await assert.rejects(
      route({ engine: 'lmstudio' }, c, decider),
      (error: unknown) => error instanceof EngineSwitchError && error.status === 400,
    );
    await assert.rejects(
      route(undefined, control(counting(lmStudioOnly).fetch, false), decider),
      (error: unknown) => error instanceof EngineSwitchError && error.status === 403,
    );
  });
});
