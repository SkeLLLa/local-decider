import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { discoverServers, saveConnection } from '../server/engines.ts';
import {
  buildConnectionPayload,
  buildDiscoverBody,
  initialForm,
  lmStudioNote,
  lmStudioSuggestion,
  parseDiscovery,
  serverSummary,
} from '../shared/connection.ts';
import { engineHint, engineOptions, parseEngineCatalog } from '../shared/engines.ts';
import { deps, fakeGateway, settings } from './fakes.ts';

const LM = {
  url: 'http://127.0.0.1:1234/v1',
  kind: 'lmstudio',
  state: 'reachable',
  models: ['qwen3', 'llama'],
};

function catalog(engines: unknown[]): ReturnType<typeof parseEngineCatalog> {
  return parseEngineCatalog({ engines });
}

describe('buildConnectionPayload', () => {
  const form = { engine: 'lmstudio', url: ' http://h/v1 ', model: ' m ', tokenEnv: '  ' } as const;

  it('trims and turns an empty token variable into null', () => {
    assert.deepEqual(buildConnectionPayload(form), {
      ok: true,
      payload: { engine: 'lmstudio', url: 'http://h/v1', model: 'm', tokenEnv: null },
    });
  });

  it('keeps a token variable name', () => {
    const res = buildConnectionPayload({ ...form, tokenEnv: ' LM_TOKEN ' });
    assert.ok(res.ok && res.payload.tokenEnv === 'LM_TOKEN');
  });

  it('refuses an empty URL or model', () => {
    assert.equal(buildConnectionPayload({ ...form, url: ' ' }).ok, false);
    assert.equal(buildConnectionPayload({ ...form, model: '' }).ok, false);
  });
});

describe('buildDiscoverBody', () => {
  it('is empty for suggestions and carries engine and URL otherwise', () => {
    assert.deepEqual(buildDiscoverBody('lmstudio', null), {});
    assert.deepEqual(buildDiscoverBody('lmstudio', '  '), {});
    assert.deepEqual(buildDiscoverBody('openai-compatible', ' http://h/v1 '), {
      engine: 'openai-compatible',
      url: 'http://h/v1',
    });
  });
});

describe('parseDiscovery', () => {
  it('reads suggestions and a single server leniently', () => {
    const got = parseDiscovery({
      suggestions: [
        LM,
        { url: 'http://x/v1', state: 'error', reason: 'unreachable', models: 3 },
        7,
      ],
      extra: true,
    });
    assert.equal(got.suggestions.length, 2);
    assert.equal(got.suggestions[1]?.state, 'error');
    assert.equal(got.suggestions[1]?.kind, 'openai-compatible');
    assert.deepEqual(got.suggestions[1]?.models, []);
    assert.equal(got.server, null);
    assert.equal(parseDiscovery({ server: LM }).server?.models.length, 2);
  });

  it('gives nothing for old or garbled bodies', () => {
    for (const body of [null, undefined, 'x', [], {}, { suggestions: 'no' }]) {
      assert.deepEqual(parseDiscovery(body), { suggestions: [], server: null });
    }
  });

  it('treats anything but an explicit reachable as an error', () => {
    assert.equal(parseDiscovery({ server: { url: 'http://x/v1' } }).server?.state, 'error');
  });
});

describe('LM Studio suggestion', () => {
  it('is found only when reachable, and its note names the URL', () => {
    const { suggestions } = parseDiscovery({
      suggestions: [
        { ...LM, state: 'error' },
        { ...LM, url: 'http://127.0.0.1:1235/v1' },
      ],
    });
    const lm = lmStudioSuggestion(suggestions);
    assert.equal(lm?.url, 'http://127.0.0.1:1235/v1');
    assert.equal(
      lm === null ? '' : lmStudioNote(lm),
      'LM Studio found at http://127.0.0.1:1235/v1. Choose LM Studio for its chat and logprob defaults. OpenAI-compatible remains available for custom settings.',
    );
    assert.equal(
      lmStudioSuggestion(
        parseDiscovery({ suggestions: [{ ...LM, kind: 'openai-compatible' }] }).suggestions,
      ),
      null,
    );
  });

  it('seeds the LM Studio form with its URL and models, keeping a listed saved model', () => {
    const saved = { url: 'http://old/v1', model: 'llama', tokenEnv: 'T' };
    const seed = { url: LM.url, models: LM.models };
    assert.deepEqual(initialForm(saved, seed), {
      url: LM.url,
      model: 'llama',
      tokenEnv: 'T',
      models: LM.models,
    });
    assert.equal(initialForm({ ...saved, model: 'gone' }, seed).model, 'qwen3');
    assert.equal(initialForm(null, seed).model, 'qwen3');
    assert.deepEqual(initialForm(saved), {
      url: 'http://old/v1',
      model: 'llama',
      tokenEnv: 'T',
      models: [],
    });
  });
});

describe('serverSummary', () => {
  it('says reachable only for a reachable server', () => {
    const [ok, bad] = parseDiscovery({
      suggestions: [LM, { url: 'http://x/v1', state: 'error', reason: 'timed out' }],
    }).suggestions;
    assert.match(serverSummary(ok!), /^Reachable at .*2 models found/);
    assert.equal(serverSummary(bad!), 'No server answered at http://x/v1: timed out.');
  });
});

describe('engines with and without connection settings', () => {
  const base = { installed: false, available: false, label: 'LM Studio', description: 'd' };

  it('new gateway: "Not configured" in the hint and option label, form offered', () => {
    const c = catalog([{ ...base, id: 'lmstudio', connection: null }]);
    const e = c.engines[0]!;
    assert.equal(e.connectable, true);
    assert.equal(e.connection, null);
    assert.match(engineHint(e), /Not configured yet\. Enter your server's URL below/);
    assert.doesNotMatch(engineHint(e), /Not installed/);
    assert.equal(engineOptions(c.engines)[0]?.label, 'LM Studio (not configured)');
  });

  it('reads a saved connection', () => {
    const c = catalog([
      {
        ...base,
        id: 'lmstudio',
        installed: true,
        available: true,
        connection: { url: 'http://h/v1', model: 'm', tokenEnv: 'T' },
      },
    ]);
    assert.deepEqual(c.engines[0]?.connection, { url: 'http://h/v1', model: 'm', tokenEnv: 'T' });
  });

  it("old gateway: no `connection` key keeps today's behaviour and hides the form", () => {
    const c = catalog([{ ...base, id: 'lmstudio', detail: 'set engines.lmstudio.url' }]);
    const e = c.engines[0]!;
    assert.equal(e.connectable, false);
    assert.match(engineHint(e), /Not installed/);
    assert.equal(engineOptions(c.engines)[0]?.label, 'LM Studio (not installed)');
  });

  it('other engines never get a form', () => {
    assert.equal(
      catalog([{ ...base, id: 'fastflowlm', connection: null }]).engines[0]?.connectable,
      false,
    );
  });
});

describe('server handlers', () => {
  it('saveConnection posts the payload and returns the saved connection', async () => {
    const gw = fakeGateway(() => null);
    gw.saveEngineConnection = async (body) => {
      gw.posts.push({ name: 'save', input: body });
      return {
        ok: true,
        body: { engine: 'lmstudio', connection: { url: 'http://h/v1', model: 'm' } },
      };
    };
    const res = await saveConnection(deps(settings(), gw), {
      engine: 'lmstudio',
      url: 'http://h/v1',
      model: 'm',
      tokenEnv: null,
    });
    assert.deepEqual(gw.posts[0]?.input, {
      engine: 'lmstudio',
      url: 'http://h/v1',
      model: 'm',
      tokenEnv: null,
    });
    assert.deepEqual(res.connection, { url: 'http://h/v1', model: 'm', tokenEnv: null });
  });

  it('shows the gateway error and an old gateway 404 without a connection', async () => {
    const gw = fakeGateway(() => null);
    gw.saveEngineConnection = async () => ({ ok: false, error: 'invalid url' });
    gw.discoverServers = async () => ({ ok: false, error: 'HTTP 404' });
    const d = deps(settings(), gw);
    const saved = await saveConnection(d, {
      engine: 'lmstudio',
      url: 'x',
      model: 'm',
      tokenEnv: null,
    });
    assert.deepEqual([saved.ok, saved.error, saved.connection], [false, 'invalid url', null]);
    const found = await discoverServers(d, {});
    assert.deepEqual(
      [found.ok, found.error, found.suggestions, found.server],
      [false, 'HTTP 404', [], null],
    );
  });

  it('discoverServers sends {} for suggestions and {engine, url} for a URL', async () => {
    const gw = fakeGateway(() => null);
    const sent: unknown[] = [];
    gw.discoverServers = async (body) => {
      sent.push(body);
      return { ok: true, body: { suggestions: [LM] } };
    };
    const d = deps(settings(), gw);
    const res = await discoverServers(d, {});
    await discoverServers(d, { engine: 'lmstudio', url: 'http://h/v1' });
    assert.deepEqual(sent, [{}, { engine: 'lmstudio', url: 'http://h/v1' }]);
    assert.equal(res.suggestions[0]?.kind, 'lmstudio');
  });
});
