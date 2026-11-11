import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ConfigFile, MemoryConfigStore } from '../src/config-file.ts';
import { parseConfig, type EngineConfig } from '../src/config.ts';
import { Decider } from '../src/decider.ts';
import { EngineControl, EngineSwitchError } from '../src/engine-control.ts';
import type { Engine, EngineHealth } from '../src/engines/types.ts';
import type { Paths } from '../src/paths.ts';
import { loadPolicies, policyDirs } from '../src/policies.ts';
import { settingsHandler } from '../src/settings-routes.ts';
import { ShadowLog } from '../src/shadow.ts';
import { stubCapabilities, tempPaths } from './helpers.ts';

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

interface Options {
  readonly raw?: Record<string, unknown>;
  readonly paths?: Paths;
  readonly persist?: boolean;
  readonly pathsEditable?: boolean;
}

interface Setup {
  readonly control: EngineControl;
  readonly created: StubEngine[];
  readonly paths: Paths;
  readonly store: ConfigFile | MemoryConfigStore;
}

function setup(options: Options = {}): Setup {
  const paths = options.paths ?? tempPaths();
  const store =
    options.persist === true
      ? ConfigFile.open(paths)
      : new MemoryConfigStore(parseConfig(options.raw ?? {}));
  if (options.persist === true && options.raw !== undefined) {
    store.update(Object.entries(options.raw).map(([key, value]) => ({ path: [key], value })));
  }
  const created: StubEngine[] = [];
  const control = new EngineControl({
    store,
    paths,
    env: { PATH: '' },
    capabilities: stubCapabilities,
    pathsEditable: options.pathsEditable ?? true,
    totalMemory: 1e12,
    installed: async (ids) => new Map(ids.map((id) => [id, true])),
    create: (config) => {
      const engine = new StubEngine(config);
      created.push(engine);
      return engine;
    },
  });
  const config = store.current;
  control.bind(
    new Decider({
      engine: control.engine,
      policies: loadPolicies(config, policyDirs(config, paths)),
      log: new ShadowLog(paths.logs),
      decisionTimeoutMs: 1000,
    }),
  );
  return { control, created, paths, store };
}

const SAVE = settingsHandler('POST /v1/config/engine', '/v1/config/engine');

async function save(control: EngineControl, body: unknown): Promise<unknown> {
  assert.ok(SAVE !== undefined);
  const [, result] = await SAVE(body, control, undefined as unknown as Decider);
  return result;
}

async function rejects(control: EngineControl, body: unknown, status = 400): Promise<string> {
  try {
    await save(control, body);
  } catch (error) {
    assert.ok(error instanceof EngineSwitchError);
    assert.equal(error.status, status);
    return error.message;
  }
  throw new Error('expected a rejection');
}

const GOOD = {
  engine: 'lmstudio',
  url: 'http://127.0.0.1:1234/v1/',
  model: 'qwen3-4b',
  tokenEnv: 'LMSTUDIO_TOKEN',
};

describe('POST /v1/config/engine', () => {
  it('rejects invalid and secret-looking payloads without touching the disk', async () => {
    const { control, paths } = setup({ persist: true });
    const file = `${paths.config}/config.yaml`;
    const existing = (): string => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return '';
      }
    };
    await save(control, { ...GOOD, engine: 'openai-compatible' });
    const before = existing();
    const secret = 'sk-live-0123456789abcdef';
    const bad: unknown[] = [
      { ...GOOD, tokenEnv: secret },
      { ...GOOD, tokenEnv: 'abc' },
      { ...GOOD, tokenEnv: 42 },
      { ...GOOD, url: `http://user:${secret}@127.0.0.1:1234/v1` },
      { ...GOOD, url: `http://127.0.0.1:1234/v1?key=${secret}` },
      { ...GOOD, url: 'http://127.0.0.1:1234/v1#frag' },
      { ...GOOD, url: 'ftp://127.0.0.1/v1' },
      { ...GOOD, url: `http://127.0.0.1/${'a'.repeat(2100)}` },
      { ...GOOD, url: 'not a url' },
      { ...GOOD, url: 'http://127.0.0.1:1234/v1\u0000' },
      { ...GOOD, url: 'http://127.0.0.1:1234/\u0007v1' },
      { ...GOOD, url: 'http://127.0.0.1:1234/v1\u007f' },
      { ...GOOD, model: 'two words' },
      { ...GOOD, model: '-leading' },
      { ...GOOD, model: '' },
      { ...GOOD, model: 'm'.repeat(301) },
      { ...GOOD, engine: 'strands-decider' },
      { ...GOOD, engine: undefined },
      { url: GOOD.url, model: GOOD.model },
      'text',
      null,
    ];
    for (const body of bad) {
      const message = await rejects(control, body);
      assert.ok(!message.includes(secret), message);
      assert.equal(existing(), before);
    }
  });

  it('rejects unknown fields without echoing their values', async () => {
    const { control, store } = setup();
    const message = await rejects(control, { ...GOOD, apiKey: 'sk-do-not-echo', token: 'sk-nope' });
    assert.match(message, /apiKey/);
    assert.ok(!message.includes('sk-do-not-echo') && !message.includes('sk-nope'), message);
    assert.equal(store.current.engines, undefined);
    const nested = await rejects(control, { ...GOOD, api: 'chat', maxTokens: 4 });
    assert.match(nested, /unknown field/);
  });

  it('keeps a save across a restart and normalizes the URL', async () => {
    const paths = tempPaths();
    const first = setup({ persist: true, paths });
    const result = (await save(first.control, GOOD)) as { connection: unknown };
    assert.deepEqual(result.connection, {
      url: 'http://127.0.0.1:1234/v1',
      model: 'qwen3-4b',
      tokenEnv: 'LMSTUDIO_TOKEN',
    });
    const second = setup({ persist: true, paths });
    assert.deepEqual(second.control.describeSettings()['connections'], {
      'openai-compatible': null,
      'lmstudio': {
        url: 'http://127.0.0.1:1234/v1',
        model: 'qwen3-4b',
        tokenEnv: 'LMSTUDIO_TOKEN',
      },
    });
    assert.equal(second.store.current.engines?.lmstudio?.model, 'qwen3-4b');
  });

  it('writes engine.* for the primary type and engines.<id> otherwise, and clears the token', async () => {
    const { control, store } = setup({
      raw: {
        engine: {
          type: 'openai-compatible',
          url: 'http://127.0.0.1:8080/v1',
          model: 'old',
          tokenEnv: 'OLD_TOKEN',
        },
      },
    });
    await save(control, {
      engine: 'openai-compatible',
      url: 'http://10.0.0.5:8000/v1',
      model: 'new',
    });
    const primary = store.current.engine;
    assert.equal(primary.type, 'openai-compatible');
    assert.equal(
      primary.type === 'openai-compatible' ? primary.url : '',
      'http://10.0.0.5:8000/v1',
    );
    assert.equal(primary.model, 'new');
    assert.equal(primary.type === 'openai-compatible' ? primary.tokenEnv : 'x', undefined);
    assert.equal(Object.keys(store.current.engines ?? {}).length, 0);

    await save(control, GOOD);
    assert.equal(store.current.engines?.lmstudio?.url, 'http://127.0.0.1:1234/v1');
    assert.equal(store.current.engines?.lmstudio?.tokenEnv, 'LMSTUDIO_TOKEN');
    assert.equal(store.current.engine.model, 'new');
    await save(control, { ...GOOD, tokenEnv: '' });
    assert.equal(store.current.engines?.lmstudio?.tokenEnv, undefined);
  });

  it('rebuilds the active engine once and never switches for an inactive save', async () => {
    const { control, created } = setup({
      raw: { engine: { type: 'lmstudio', url: 'http://127.0.0.1:1234/v1', model: 'a' } },
    });
    const baseline = created.length;

    await save(control, {
      engine: 'openai-compatible',
      url: 'http://127.0.0.1:8080/v1',
      model: 'x',
    });
    await control.idle();
    assert.equal(created.length, baseline);
    assert.equal(control.current()?.engine, 'lmstudio');
    assert.equal(control.current()?.model, 'a');
    assert.equal(control.settings.selection, undefined);

    await save(control, { engine: 'lmstudio', url: 'http://127.0.0.1:1235/v1', model: 'b' });
    await control.idle();
    assert.equal(created.length, baseline + 1);
    assert.equal(control.current()?.model, 'b');
    assert.equal(control.engine.model, 'b');

    await save(control, { engine: 'lmstudio', url: 'http://127.0.0.1:1235/v1', model: 'b' });
    await control.idle();
    assert.equal(created.length, baseline + 1);
  });

  it('refuses to save where tool paths cannot be edited', async () => {
    const { control, store } = setup({ pathsEditable: false });
    await rejects(control, GOOD, 403);
    assert.equal(store.current.engines, undefined);
  });
});
