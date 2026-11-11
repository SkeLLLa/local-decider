import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isOpenAILike,
  ModelDiscovery,
  nativeModelsUrl,
  parseNativeModels,
  parseModelIds,
  type DiscoveryEndpoint,
} from '../src/engine-discovery.ts';

interface Call {
  readonly url: string;
  readonly auth: string | null;
}

function fakeFetch(models: Record<string, readonly string[]>, calls: Call[] = []): typeof fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const ids = models[url.replace(/\/models$/, '')];
    return Promise.resolve(
      ids === undefined
        ? new Response('nope', { status: 500 })
        : Response.json({ data: ids.map((id) => ({ id })) }),
    );
  };
}

const endpoint = (url: string, model = 'm0', tokenEnv?: string): DiscoveryEndpoint => ({
  url,
  model,
  ...(tokenEnv === undefined ? {} : { tokenEnv }),
});

describe('parseModelIds', () => {
  it('keeps valid unique ids and drops malformed ones', () => {
    assert.deepEqual(
      parseModelIds({ data: [{ id: 'a' }, { id: 'a' }, { id: '-x' }, { id: 'b c' }, {}, 3] }),
      ['a'],
    );
    assert.deepEqual(parseModelIds({ data: 'x' }), []);
    assert.deepEqual(parseModelIds(null), []);
  });
});

describe('ModelDiscovery', () => {
  it('puts the configured model first and lists the rest', async () => {
    const discovery = new ModelDiscovery({}, fakeFetch({ 'http://h/v1': ['a', 'm0', 'b'] }));
    const ep = endpoint('http://h/v1');
    await discovery.refresh('openai-compatible', ep);
    assert.deepEqual(discovery.models('openai-compatible', ep), ['m0', 'a', 'b']);
  });

  it('falls back to the configured model when the server fails', async () => {
    const discovery = new ModelDiscovery({}, fakeFetch({}));
    const ep = endpoint('http://down/v1');
    await discovery.refresh('openai-compatible', ep);
    assert.deepEqual(discovery.models('openai-compatible', ep), ['m0']);
  });

  it('never shows models found with another endpoint config', async () => {
    const discovery = new ModelDiscovery(
      {},
      fakeFetch({ 'http://one/v1': ['a'], 'http://two/v1': ['z'] }),
    );
    const one = endpoint('http://one/v1');
    await discovery.refresh('openai-compatible', one);
    assert.deepEqual(discovery.models('openai-compatible', endpoint('http://two/v1')), []);
    assert.deepEqual(discovery.models('openai-compatible', endpoint('http://one/v1', 'other')), []);
    await discovery.refresh('openai-compatible', endpoint('http://two/v1'));
    assert.deepEqual(discovery.models('openai-compatible', one), []);
  });

  it('forgets everything once the engine has no endpoint', async () => {
    const discovery = new ModelDiscovery({}, fakeFetch({ 'http://h/v1': ['a'] }));
    const ep = endpoint('http://h/v1');
    await discovery.refresh('openai-compatible', ep);
    await discovery.refresh('openai-compatible', undefined);
    assert.deepEqual(discovery.models('openai-compatible', ep), []);
  });

  it('sends the token only over loopback or https', async () => {
    const calls: Call[] = [];
    const env = { KEY: 'secret' };
    const discovery = new ModelDiscovery(
      env,
      fakeFetch({ 'http://127.0.0.1:1/v1': [], 'http://example.com/v1': [] }, calls),
    );
    await discovery.refresh('openai-compatible', endpoint('http://127.0.0.1:1/v1', 'm0', 'KEY'));
    await discovery.refresh('openai-compatible', endpoint('http://example.com/v1', 'm0', 'KEY'));
    assert.deepEqual(
      calls.map((c) => c.auth),
      ['Bearer secret', null],
    );
  });
});

describe('isOpenAILike', () => {
  it('names the OpenAI-style engines only', () => {
    assert.ok(isOpenAILike('openai-compatible'));
    assert.ok(!isOpenAILike('fastflowlm'));
  });
});

const NATIVE = {
  data: [
    { id: 'idle-llm', type: 'llm', state: 'not-loaded', compatibility_type: 'gguf' },
    { id: 'embed', type: 'embeddings', state: 'loaded', compatibility_type: 'gguf' },
    { id: 'hot-vlm', type: 'vlm', state: 'loaded', compatibility_type: 'mlx', runtime: 'mlx-llm' },
    { id: 'hot-vlm', type: 'llm', state: 'not-loaded' },
    { id: '-bad', type: 'llm', state: 'loaded' },
    { id: 'hot-llm', type: 'llm', state: 'loaded' },
  ],
};

function nativeFetch(
  native: unknown,
  calls: string[] = [],
  fallback: readonly string[] = [],
): typeof fetch {
  return (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push(url);
    if (url.endsWith('/api/v0/models')) {
      return Promise.resolve(
        native === undefined ? new Response('x', { status: 404 }) : Response.json(native),
      );
    }
    return Promise.resolve(Response.json({ data: fallback.map((id) => ({ id })) }));
  };
}

describe('LM Studio native discovery', () => {
  it('derives the native url by stripping /v1', () => {
    assert.equal(nativeModelsUrl('http://h:1234/v1'), 'http://h:1234/api/v0/models');
    assert.equal(nativeModelsUrl('http://h:1234/v1/'), 'http://h:1234/api/v0/models');
    assert.equal(nativeModelsUrl('https://h/x/v1'), 'https://h/x/api/v0/models');
  });

  it('parses types, loaded state, format and runtime, deduping and validating ids', () => {
    const parsed = parseNativeModels(NATIVE);
    assert.deepEqual(
      parsed.map((m) => [m.id, m.usable, m.loaded, m.format, m.runtime]),
      [
        ['idle-llm', true, false, 'GGUF', undefined],
        ['embed', false, true, 'GGUF', undefined],
        ['hot-vlm', true, true, 'MLX', 'mlx-llm'],
        ['hot-llm', true, true, undefined, undefined],
      ],
    );
  });

  it('lists loaded llm/vlm first, stably, without embedding models, with details', async () => {
    const calls: string[] = [];
    const discovery = new ModelDiscovery({}, nativeFetch(NATIVE, calls));
    const ep = endpoint('http://h:1234/v1', 'idle-llm');
    await discovery.refresh('lmstudio', ep);
    assert.deepEqual(calls, ['http://h:1234/api/v0/models']);
    assert.deepEqual(discovery.models('lmstudio', ep), ['hot-vlm', 'hot-llm', 'idle-llm']);
    assert.equal(discovery.detail('lmstudio', ep, 'hot-vlm'), 'MLX · mlx-llm');
    assert.equal(discovery.detail('lmstudio', ep, 'idle-llm'), 'GGUF');
    assert.equal(discovery.detail('lmstudio', ep, 'hot-llm'), undefined);
  });

  it('adds an absent configured model but never an embedding one', async () => {
    const discovery = new ModelDiscovery({}, nativeFetch(NATIVE));
    const absent = endpoint('http://h/v1', 'cfg');
    await discovery.refresh('lmstudio', absent);
    assert.deepEqual(discovery.models('lmstudio', absent), [
      'cfg',
      'hot-vlm',
      'hot-llm',
      'idle-llm',
    ]);
    const embed = endpoint('http://h/v1', 'embed');
    await discovery.refresh('lmstudio', embed);
    assert.ok(!discovery.models('lmstudio', embed).includes('embed'));
  });

  it('falls back to /v1/models, then to the configured model', async () => {
    const calls: string[] = [];
    const discovery = new ModelDiscovery({}, nativeFetch(undefined, calls, ['a', 'm0']));
    const ep = endpoint('http://h/v1');
    await discovery.refresh('lmstudio', ep);
    assert.deepEqual(calls, ['http://h/api/v0/models', 'http://h/v1/models']);
    assert.deepEqual(discovery.models('lmstudio', ep), ['m0', 'a']);
    const down = new ModelDiscovery({}, () => Promise.reject(new Error('down')));
    await down.refresh('lmstudio', ep);
    assert.deepEqual(down.models('lmstudio', ep), ['m0']);
  });

  it('keeps the token rule: only over https or loopback', async () => {
    const auths: (string | null)[] = [];
    const doFetch: typeof fetch = (_url, init) => {
      auths.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(Response.json({ data: [] }));
    };
    const discovery = new ModelDiscovery({ TOK: 's' }, doFetch);
    await discovery.refresh('lmstudio', endpoint('http://127.0.0.1:1234/v1', 'm', 'TOK'));
    await discovery.refresh('lmstudio', endpoint('http://example.com/v1', 'm', 'TOK'));
    assert.deepEqual(auths, ['Bearer s', null]);
  });

  it('leaves openai-compatible on /models only', async () => {
    const calls: string[] = [];
    const discovery = new ModelDiscovery({}, nativeFetch(NATIVE, calls, ['x']));
    await discovery.refresh('openai-compatible', endpoint('http://h/v1'));
    assert.deepEqual(calls, ['http://h/v1/models']);
  });
});
