import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isOpenAILike,
  ModelDiscovery,
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
