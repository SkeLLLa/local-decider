import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ConfigFile, MemoryConfigStore } from '../src/config-file.ts';
import { parseConfig, type EngineConfig } from '../src/config.ts';
import { Decider } from '../src/decider.ts';
import {
  EngineControl,
  EngineSwitchError,
  parseLifecycle,
  parseMode,
  parsePathUpdate,
  parseSelection,
  parseThresholds,
} from '../src/engine-control.ts';
import type { HostInfo } from '../src/engines/descriptor.ts';
import type { HostCapabilities } from '../src/engines/host-capabilities.ts';
import type { Engine, EngineHealth } from '../src/engines/types.ts';
import type { Paths } from '../src/paths.ts';
import { defaultPolicyDir, loadPolicies, policyDirs } from '../src/policies.ts';
import { startGateway } from '../src/runtime.ts';
import {
  FakeEngine,
  NO_CAPABILITIES,
  stubCapabilities,
  tempLog,
  tempPaths,
  testConfig,
} from './helpers.ts';

class ModelEngine implements Engine {
  readonly id: string;
  readonly model: string;
  readonly config: EngineConfig;
  started = 0;
  stopped = 0;
  constructor(config: EngineConfig) {
    this.config = config;
    this.id = config.type;
    this.model = config.model;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  health(): EngineHealth {
    return { state: 'starting', model: this.model };
  }
  async decide(): Promise<never> {
    throw new Error('not used');
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

function recommendationOf(status: Record<string, unknown>): string | undefined {
  const rec = status['recommendation'] as { automatic: { engine: string } | null };
  return rec.automatic?.engine;
}

async function settleEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The test PATH: where the fake system tools live. */
function binDir(paths: Paths): string {
  return join(paths.data, 'bin');
}

/** A fake `flm` on the test PATH, so the FastFlowLM engine counts as installed. */
function fakeFlm(paths: Paths): string {
  const dir = binDir(paths);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'flm');
  writeFileSync(file, `#!${process.execPath}\nconsole.log('FLM v1.0.12')\n`);
  chmodSync(file, 0o755);
  return file;
}

function fakeStrands(paths: Paths): void {
  const dir = join(paths.venvs, 'strands-decider', 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'strands-decider'), `#!${process.execPath}\n`);
  chmodSync(join(dir, 'strands-decider'), 0o755);
}

async function withModelServer(
  respond: (response: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_request, response) => respond(response));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${String(address.port)}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

interface Setup {
  readonly control: EngineControl;
  readonly decider: Decider;
  readonly created: ModelEngine[];
  readonly paths: Paths;
}

interface SetupOptions {
  readonly engine?: Record<string, unknown>;
  readonly engines?: Record<string, unknown>;
  readonly totalMemory?: number;
  readonly installed?: boolean;
  readonly paths?: Paths;
  readonly capabilities?: () => Promise<HostCapabilities>;
  readonly persist?: boolean;
  readonly host?: HostInfo;
}

const LINUX_HOST: HostInfo = {
  platform: 'linux',
  arch: 'x64',
  totalMemoryBytes: 64e9,
};

const DARWIN_HOST: HostInfo = {
  platform: 'darwin',
  arch: 'arm64',
  totalMemoryBytes: 64e9,
};

function setup(options: SetupOptions = {}): Setup {
  const paths = options.paths ?? tempPaths();
  fakeFlm(paths);
  fakeStrands(paths);
  const store =
    options.persist === true
      ? ConfigFile.open(paths)
      : new MemoryConfigStore(
          parseConfig({ engine: { type: 'strands-decider', ...options.engine } }),
        );
  if (options.engines !== undefined) {
    store.update(
      Object.entries(options.engines).map(([id, value]) => ({
        path: ['engines', id],
        value,
      })),
    );
  }
  const config = store.current;
  const created: ModelEngine[] = [];
  const control = new EngineControl({
    store,
    paths,
    env: { PATH: binDir(paths) },
    capabilities: options.capabilities ?? stubCapabilities,
    ...(options.host === undefined ? {} : { host: options.host }),
    totalMemory: options.totalMemory ?? 1e12,
    installed: async (ids) => new Map(ids.map((id) => [id, options.installed ?? true])),
    create: (c) => {
      const next = new ModelEngine(c);
      created.push(next);
      return next;
    },
  });
  const decider = new Decider({
    engine: control.engine,
    policies: loadPolicies(config, policyDirs(config, paths)),
    log: tempLog(),
    decisionTimeoutMs: 1000,
  });
  control.bind(decider);
  return { control, decider, created, paths };
}

/** A copy of the shipped routing policy under a new id, as a user variant. */
function writeUserVariant(paths: Paths, id: string): void {
  const source = readFileSync(join(defaultPolicyDir(), 'routing.yaml'), 'utf8');
  mkdirSync(join(paths.config, 'policies'), { recursive: true });
  writeFileSync(
    join(paths.config, 'policies', `${id}.yaml`),
    source.replace('id: routing', `id: ${id}\nvariantOf: routing`),
  );
}

const E2B = 'StrandsAgents/strands-decider-E2B-gemma4-v1-2610';

describe('EngineControl switching', () => {
  it('reports starting while the previous engine is stopping', async () => {
    const { control, created } = setup();
    const stopping = deferred<void>();
    created[0]!.stop = () => stopping.promise;
    const switching = control.select({ model: E2B, device: 'cpu' });
    await settleEventLoop();
    assert.equal(control.activeHealth().state, 'starting');
    assert.equal(
      (await control.status())['active'] &&
        ((await control.status())['active'] as Record<string, unknown>)['state'],
      'starting',
    );
    stopping.resolve();
    await switching;
  });

  it('swaps in a new engine for an allowed model and stops the old one', async () => {
    const { control, decider, created } = setup();
    const result = await control.select({ model: E2B, device: 'cpu' });
    assert.deepEqual(result, { engine: 'strands-decider', model: E2B, device: 'cpu' });
    await control.idle();
    assert.equal(created.length, 2);
    assert.equal(created[0]?.stopped, 1);
    assert.equal(decider.engine.model, E2B);
    // Lazy lifecycle (the default): the new engine loads on its first decision, not on switch.
    assert.equal(created[1]?.started, 0);
  });

  it('switches engines: strands-decider to FastFlowLM d3', async () => {
    const { control, decider, created } = setup();
    const result = await control.select({ engine: 'fastflowlm', model: 'd3:nano' });
    assert.deepEqual(result, { engine: 'fastflowlm', model: 'd3:nano', device: null });
    assert.equal(created.at(-1)?.config.type, 'fastflowlm');
    assert.equal(decider.engine.id, 'fastflowlm');
  });

  it('lists OpenAI-compatible as unavailable until configured', async () => {
    const { control } = setup({ host: DARWIN_HOST });
    const status = await control.status();
    const engines = status['engines'] as Record<string, unknown>[];
    const openai = engines.find((engine) => engine['id'] === 'openai-compatible');
    assert.equal(openai?.['available'], false);
    assert.equal(openai?.['supported'], true);
    assert.equal(
      openai?.['detail'],
      "Not configured. Enter your server's API base URL and choose or type a model below. Nothing to install.",
    );
    assert.deepEqual(
      status['models'] &&
        (status['models'] as unknown[]).filter(
          (model) => (model as Record<string, unknown>)['engine'] === 'openai-compatible',
        ),
      [],
    );
  });

  it('selects the configured OpenAI-compatible model and rejects unknown models', async () => {
    const { control, created } = setup({
      engines: {
        'openai-compatible': { url: 'http://127.0.0.1:1234/v1', model: 'local-model' },
      },
    });
    const status = await control.status();
    const engines = status['engines'] as Record<string, unknown>[];
    const openai = engines.find((engine) => engine['id'] === 'openai-compatible');
    assert.equal(openai?.['available'], true);
    const models = status['models'] as Record<string, unknown>[];
    const model = models.find((entry) => entry['id'] === 'local-model');
    assert.equal(model?.['engine'], 'openai-compatible');
    assert.equal(model?.['downloadGb'], null);
    assert.equal(model?.['memoryGb'], null);
    assert.equal(model?.['installed'], true);

    await control.select({ engine: 'openai-compatible', model: 'local-model' });
    assert.equal(created.at(-1)?.config.type, 'openai-compatible');
    assert.deepEqual(control.settings.selection, {
      engine: 'openai-compatible',
      model: 'local-model',
    });
    await assert.rejects(
      control.select({ engine: 'openai-compatible', model: 'other-model' }),
      (error: unknown) => error instanceof EngineSwitchError && error.status === 400,
    );
  });

  it('lists discovered OpenAI models with the configured model first and selects them', async () => {
    await withModelServer(
      (response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: [
              { id: 'discovered-model' },
              { id: 12 },
              null,
              { name: 'missing-id' },
              { id: 'configured-model' },
              { id: 'discovered-model' },
            ],
          }),
        );
      },
      async (url) => {
        const { control, created } = setup({
          engines: {
            'openai-compatible': { url, model: 'configured-model' },
          },
        });
        await control.status();
        await control.refreshDiscovery();
        const status = await control.status();
        const models = (status['models'] as Record<string, unknown>[]).filter(
          (model) => model['engine'] === 'openai-compatible',
        );
        assert.deepEqual(
          models.map((model) => model['id']),
          ['configured-model', 'discovered-model'],
        );
        assert.ok(
          models.every((model) => model['downloadGb'] === null && model['installed'] === true),
        );

        await control.select({ engine: 'openai-compatible', model: 'discovered-model' });
        assert.equal(created.at(-1)?.model, 'discovered-model');
      },
    );
  });

  it('falls back to the configured OpenAI model on 404 and malformed model lists', async () => {
    for (const [status, body] of [
      [404, '{"error":"not found"}'],
      [200, 'not-json'],
    ] as const) {
      await withModelServer(
        (response) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(body);
        },
        async (url) => {
          const { control } = setup({
            engines: { 'openai-compatible': { url, model: 'configured-only' } },
          });
          await control.status();
          await control.refreshDiscovery();
          const statusBody = await control.status();
          const models = (statusBody['models'] as Record<string, unknown>[]).filter(
            (model) => model['engine'] === 'openai-compatible',
          );
          assert.deepEqual(
            models.map((model) => model['id']),
            ['configured-only'],
          );
        },
      );
    }
  });

  it('uses and reapplies per-engine options when switching to FastFlowLM', async () => {
    const paths = tempPaths();
    const { control, created } = setup({
      paths,
      persist: true,
      host: LINUX_HOST,
      engines: { fastflowlm: { pmode: 'balanced' } },
    });
    assert.equal(created[0]?.config.type, 'strands-decider');
    await control.select({ engine: 'fastflowlm', model: 'd3:nano' });
    const balanced = created.at(-1)?.config;
    assert.equal(balanced?.type, 'fastflowlm');
    if (balanced?.type === 'fastflowlm') {
      assert.equal(balanced.pmode, 'balanced');
    }

    ConfigFile.open(paths).update([{ path: ['engines', 'fastflowlm', 'pmode'], value: 'turbo' }]);
    await control.reloadConfig();
    assert.equal(created.length, 3);
    assert.equal(created[1]?.stopped, 1);
    const turbo = created.at(-1)?.config;
    assert.equal(turbo?.type, 'fastflowlm');
    if (turbo?.type === 'fastflowlm') {
      assert.equal(turbo.pmode, 'turbo');
    }
  });

  it('refuses a model of another engine, unknown models and undownloaded ones', async () => {
    const { control } = setup();
    await assert.rejects(
      control.select({ engine: 'fastflowlm', model: E2B }),
      /unknown fastflowlm model/,
    );
    await assert.rejects(control.select({ model: '--evil' }), EngineSwitchError);
    const fresh = setup({ installed: false });
    await assert.rejects(fresh.control.select({ model: E2B }), /not downloaded yet/);
  });

  it('keeps the running engine when nothing changes, and the device when none is named', async () => {
    const { control, created } = setup({ engine: { device: 'cpu' } });
    const current = control.current();
    assert.ok(current !== null);
    await control.select({ model: current.model });
    assert.equal(created.length, 1);
    assert.equal((await control.select({ model: E2B })).device, 'cpu');
  });

  it('refuses models that do not fit, by device', async () => {
    const big = 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610';
    const { control } = setup({ totalMemory: 32e9 });
    await assert.rejects(control.select({ model: big, device: 'cpu' }), (error: unknown) => {
      assert.ok(error instanceof EngineSwitchError);
      assert.equal(error.status, 409);
      assert.match(error.message, /needs ~30 GB/);
      return true;
    });
    // bf16 on an accelerator needs ~15 GB, which fits in 80% of 32 GB.
    assert.equal((await control.select({ model: big, device: 'mlx' })).model, big);
  });

  it('accepts the configured model even when it is not in the catalogue', () => {
    const { control } = setup({ engine: { model: 'me/custom-decider' } });
    assert.ok(control.allowedModels('strands-decider').includes('me/custom-decider'));
  });

  it('is not switchable when attached to a running engine', async () => {
    const { control } = setup({ engine: { url: 'http://127.0.0.1:9999' } });
    assert.equal(control.switchable, false);
    await assert.rejects(control.select({ model: E2B }), /cannot switch/);
  });
});

describe('EngineControl state', () => {
  it('writes the selection, lifecycle and policy modes to config.yaml, and restores them', async () => {
    const paths = tempPaths();
    const first = setup({ paths, persist: true });
    await first.control.select({ engine: 'fastflowlm', model: 'd3:nano' });
    first.control.setLifecycle({ lifecycle: 'eager', idleUnloadMinutes: 30 });
    first.control.setPolicyMode('permission', 'act');
    const saved = ConfigFile.open(paths).current;
    assert.deepEqual(saved.selection, { engine: 'fastflowlm', model: 'd3:nano' });
    assert.deepEqual(saved.lifecycle, { mode: 'eager', idleUnloadMinutes: 30 });
    assert.deepEqual(saved.policies, { permission: { mode: 'act' } });

    const second = setup({ paths, persist: true });
    assert.equal(second.control.current()?.engine, 'fastflowlm');
    assert.equal(second.control.engine.lifecycle.lifecycle, 'eager');
    assert.equal(second.decider.policies.get('permission')?.mode, 'act');
  });

  it('reloads a new user variant and persists choosing it', () => {
    const paths = tempPaths();
    const first = setup({ paths, persist: true });
    assert.throws(() => first.control.setPolicyVariant('routing', 'routing-mine'), /not a variant/);
    writeUserVariant(paths, 'routing-mine');
    assert.ok(first.control.reloadPolicies().includes('routing-mine'));
    first.control.setPolicyVariant('routing', 'routing-mine');
    assert.deepEqual(ConfigFile.open(paths).current.policies, {
      routing: { variant: 'routing-mine' },
    });

    const second = setup({ paths, persist: true });
    assert.equal(second.decider.activeVariant('routing'), 'routing-mine');
    second.control.setPolicyVariant('routing', 'routing');
    assert.deepEqual(ConfigFile.open(paths).current.policies, {}, 'empty sections are dropped');
  });

  it('persists rule thresholds, validates them and restores them', () => {
    const paths = tempPaths();
    const first = setup({ paths, persist: true });
    const effective = first.control.setPolicyThresholds('permission', { 'verdict.allow': 0.9 });
    assert.equal(effective[0]?.value, 0.9);
    assert.equal(effective[0]?.default, 0.95);
    assert.deepEqual(ConfigFile.open(paths).current.policies, {
      permission: { thresholds: { 'verdict.allow': 0.9 } },
    });
    assert.throws(
      () => first.control.setPolicyThresholds('permission', { 'verdict.maybe': 0.5 }),
      /no rule for "verdict.maybe"/,
    );
    assert.throws(() => first.control.setPolicyThresholds('nope', { 'a.b': 0.5 }), /unknown/);
    assert.throws(
      () => first.control.setPolicyThresholds('permission', { 'verdict.allow': 0.49 }),
      (error: unknown) =>
        error instanceof EngineSwitchError &&
        error.status === 400 &&
        /at least 0.5/.test(error.message),
    );
    assert.equal(
      first.control.setPolicyThresholds('permission', {
        'verdict.allow': 0.5,
        'verdict.deny': 0.1,
      })[1]?.value,
      0.1,
      'the floor is for allow rules only',
    );
    first.control.setPolicyThresholds('permission', { 'verdict.allow': 0.9, 'verdict.deny': null });

    const second = setup({ paths, persist: true });
    assert.equal(second.decider.thresholdsOf('permission')[0]?.value, 0.9);
    second.control.setPolicyThresholds('permission', { 'verdict.allow': null });
    assert.equal(second.decider.thresholdsOf('permission')[0]?.value, 0.95);
    assert.deepEqual(ConfigFile.open(paths).current.policies, {}, 'empty sections are dropped');
  });

  it('applies thresholds from an outside edit of config.yaml', async () => {
    const paths = tempPaths();
    const { control, decider } = setup({ paths, persist: true });
    mkdirSync(paths.config, { recursive: true });
    const file = join(paths.config, 'config.yaml');
    writeFileSync(
      file,
      'policies:\n  permission:\n    thresholds: { verdict.deny: 0.6, verdict.allow: 0.2 }\n',
    );
    assert.deepEqual(await control.reloadConfig(), { changed: true, notes: [] });
    assert.equal(decider.thresholdsOf('permission')[1]?.value, 0.6);
    assert.equal(
      decider.thresholdsOf('permission')[0]?.value,
      0.5,
      'allow is clamped to its floor',
    );
    writeFileSync(file, '# none\n');
    await control.reloadConfig();
    assert.equal(decider.thresholdsOf('permission')[1]?.value, 0.8);
    writeFileSync(file, 'policies:\n  permission:\n    thresholds: { verdict.deny: 2 }\n');
    await assert.rejects(control.reloadConfig(), /thresholds/);
  });

  it('applies an outside edit of config.yaml: variant, mode, lifecycle and presets', async () => {
    const paths = tempPaths();
    const { control, decider } = setup({ paths, persist: true });
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(
      join(paths.config, 'config.yaml'),
      [
        '# mine',
        'policies:',
        '  routing: { mode: act, variant: routing-budget }',
        'lifecycle: { mode: eager }',
        'routing:',
        '  presets:',
        '    claude-code: { cheap: { model: haiku } }',
        '',
      ].join('\n'),
    );
    assert.deepEqual(await control.reloadConfig(), { changed: true, notes: [] });
    assert.equal(decider.activeVariant('routing'), 'routing-budget');
    assert.equal(decider.policies.get('routing')?.mode, 'act');
    assert.equal(control.engine.lifecycle.lifecycle, 'eager');
    assert.equal(control.settings.routing.presets['claude-code']?.['cheap']?.model, 'haiku');
    assert.deepEqual(await control.reloadConfig(), { changed: false, notes: [] });
  });

  it('keeps comments when the settings pages write, and refuses invalid outside edits', async () => {
    const paths = tempPaths();
    const { control } = setup({ paths, persist: true });
    const file = join(paths.config, 'config.yaml');
    mkdirSync(paths.config, { recursive: true });
    writeFileSync(file, '# keep me\nport: 8765 # and me\n');
    await control.reloadConfig();
    control.setRoutingPreset('paseo', 'cheap', { model: 'claude/haiku' });
    const text = readFileSync(file, 'utf8');
    assert.match(text, /yaml-language-server: \$schema=schemas\/config\.schema\.json/);
    assert.match(text, /# keep me/);
    assert.match(text, /port: 8765 # and me/);
    assert.match(text, /cheap:\s+model: claude\/haiku/);
    writeFileSync(file, 'port: nope\n');
    await assert.rejects(control.reloadConfig(), /port/);
    assert.equal(control.settings.routing.presets.paseo?.['cheap']?.model, 'claude/haiku');
  });

  it('keeps an outside edit not yet applied when the settings page saves', async () => {
    const paths = tempPaths();
    const { control } = setup({ paths, persist: true });
    const file = join(paths.config, 'config.yaml');
    control.setPolicyMode('permission', 'act');
    writeFileSync(file, `${readFileSync(file, 'utf8')}# my note\nlifecycle: { mode: eager }\n`);
    control.setPolicyMode('turn-outcome', 'act');
    const text = readFileSync(file, 'utf8');
    assert.match(text, /# my note/);
    assert.match(text, /mode: eager/);
    assert.equal(text.match(/yaml-language-server/g)?.length, 1, 'one schema header');
    await control.reloadConfig();
    assert.equal(control.engine.lifecycle.lifecycle, 'eager', 'the watcher path still applies it');
    writeFileSync(file, 'port: nope\n');
    assert.throws(() => control.setPolicyMode('permission', 'off'), /invalid; fix them first/);
    assert.equal(readFileSync(file, 'utf8'), 'port: nope\n', 'the invalid edit is not clobbered');
  });

  it('removes keys whose section does not exist as a no-op', async () => {
    const paths = tempPaths();
    const { control } = setup({ paths, persist: true });
    control.setRoutingPreset('paseo', 'fast', null);
    control.setPolicyVariant('routing', 'routing');
    const flm = fakeFlm(paths);
    assert.equal((await control.setPath('tools.flm', null)).value, null);
    assert.ok(flm);
  });

  it('goes back to the default variant when config.yaml no longer names one', async () => {
    const paths = tempPaths();
    const { control, decider } = setup({ paths, persist: true });
    control.setPolicyVariant('routing', 'routing-budget');
    writeFileSync(join(paths.config, 'config.yaml'), '# emptied by hand\n');
    await control.reloadConfig();
    assert.equal(decider.activeVariant('routing'), 'routing');
  });

  it('applies the rest of a config change when a policy file is broken, and retries policies', async () => {
    const paths = tempPaths();
    const { control } = setup({ paths, persist: true });
    mkdirSync(join(paths.config, 'policies'), { recursive: true });
    writeFileSync(join(paths.config, 'policies', 'half.yaml'), 'id: [unclosed');
    writeFileSync(
      join(paths.config, 'config.yaml'),
      'lifecycle: { mode: eager }\npolicies: { routing: { mode: act } }\n',
    );
    const { notes } = await control.reloadConfig();
    assert.match(notes.join('\n'), /policies not reloaded/);
    assert.equal(control.engine.lifecycle.lifecycle, 'eager');
    writeFileSync(join(paths.config, 'policies', 'half.yaml'), '');
    rmSync(join(paths.config, 'policies', 'half.yaml'));
    assert.deepEqual((await control.reloadConfig()).notes, [], 'retried and applied');
  });

  it('refuses routing preset changes on a remote (token) gateway', () => {
    const remote = new EngineControl({
      store: new MemoryConfigStore(parseConfig({})),
      paths: tempPaths(),
      pathsEditable: false,
      create: (c) => new ModelEngine(c),
    });
    assert.throws(() => remote.setRoutingPreset('paseo', 'fast', { model: 'x/y' }), /loopback/);
  });

  it('writes through a symlinked config.yaml', () => {
    const paths = tempPaths();
    mkdirSync(paths.config, { recursive: true });
    const real = join(paths.data, 'dotfiles-config.yaml');
    mkdirSync(paths.data, { recursive: true });
    writeFileSync(real, '# managed elsewhere\n');
    symlinkSync(real, join(paths.config, 'config.yaml'));
    const { control } = setup({ paths, persist: true });
    control.setRoutingPreset('codex', 'deep', { model: 'gpt-6.1-sol', thinking: 'high' });
    assert.ok(lstatSync(join(paths.config, 'config.yaml')).isSymbolicLink());
    assert.match(readFileSync(real, 'utf8'), /thinking: high/);
  });

  it('folds a pre-YAML state.json into config.yaml once', () => {
    const paths = tempPaths();
    mkdirSync(paths.data, { recursive: true });
    writeFileSync(
      join(paths.data, 'state.json'),
      JSON.stringify({
        selection: { engine: 'openai-compatible', model: 'local-model' },
        lifecycle: { lifecycle: 'eager', idleUnloadMinutes: 20 },
        paths: { 'dirs.hfCache': '/tmp', 'bogus.key': '/x', 'tools.uv': '' },
        policyModes: { permission: 'act', bad: 'loud' },
        policyVariants: { routing: 'routing-budget' },
      }),
    );
    const config = ConfigFile.open(paths).current;
    assert.deepEqual(config.selection, { engine: 'openai-compatible', model: 'local-model' });
    assert.deepEqual(config.lifecycle, { mode: 'eager', idleUnloadMinutes: 20 });
    assert.equal(config.dirs.hfCache, '/tmp');
    assert.deepEqual(config.policies, {
      permission: { mode: 'act' },
      routing: { variant: 'routing-budget' },
    });
    assert.equal(existsSync(join(paths.data, 'state.json')), false);
    assert.equal(existsSync(join(paths.data, 'state.json.migrated')), true);
  });

  it('keeps the old policies when a reloaded file is invalid', () => {
    const paths = tempPaths();
    const { control, decider } = setup({ paths });
    mkdirSync(join(paths.config, 'policies'), { recursive: true });
    writeFileSync(join(paths.config, 'policies', 'broken.yaml'), 'id: [unclosed');
    assert.throws(() => control.reloadPolicies(), /invalid YAML/);
    assert.ok(decider.policies.has('routing'));
  });

  it('rejects unknown policies for mode changes', () => {
    const { control } = setup();
    assert.throws(() => control.setPolicyMode('nope', 'act'), /unknown policy/);
  });

  it('reports engines, models, paths and downloads', async () => {
    const { control } = setup();
    const status = await control.status();
    const engines = status['engines'] as { id: string; installed: boolean }[];
    assert.deepEqual(
      engines.map((e) => e.id),
      ['strands-decider', 'fastflowlm', 'openai-compatible', 'lmstudio'],
    );
    assert.equal(engines.find((e) => e.id === 'fastflowlm')?.installed, true);
    const models = status['models'] as { id: string; recommended: boolean; quality: unknown }[];
    assert.ok(models.some((m) => m.id === 'd3:mini' && m.recommended));
    assert.ok(Array.isArray(status['paths']));
    assert.equal((status['active'] as { lifecycle: string }).lifecycle, 'lazy');
  });

  it('finds an flm installed after start, with an install link until then', async () => {
    const { control, created, paths } = setup();
    rmSync(join(binDir(paths), 'flm'));
    type Row = { id: string; installed: boolean; installUrl?: string };
    const flmRow = async (): Promise<Row | undefined> =>
      ((await control.status())['engines'] as Row[]).find((e) => e.id === 'fastflowlm');
    const before = await flmRow();
    assert.equal(before?.installed, false);
    assert.equal(before?.installUrl, 'https://github.com/FastFlowLM/FastFlowLM');
    const engines = created.length;
    fakeFlm(paths);
    const after = await flmRow();
    assert.equal(after?.installed, true);
    assert.equal(after?.installUrl, undefined);
    await settleEventLoop();
    assert.equal(created.length, engines, 'the running strands-decider engine is not restarted');
  });

  it('lists each engine and reports host support from its descriptor', async () => {
    const darwinStatus = await setup({ host: DARWIN_HOST }).control.status();
    const darwinEngines = darwinStatus['engines'] as {
      id: string;
      label: string;
      devices: string[];
      supported: boolean;
      unsupportedReason?: string;
    }[];
    assert.deepEqual(
      darwinEngines.map(({ id }) => id),
      ['strands-decider', 'fastflowlm', 'openai-compatible', 'lmstudio'],
    );
    const darwinFlm = darwinEngines.find(({ id }) => id === 'fastflowlm');
    assert.ok(darwinFlm);
    assert.equal(darwinFlm.supported, false);
    assert.equal(darwinFlm.unsupportedReason, 'FastFlowLM is supported only on Linux');
    assert.equal(darwinFlm.label, 'FastFlowLM (AMD NPU)');
    assert.deepEqual(darwinFlm.devices, []);
    const darwinStrands = darwinEngines.find(({ id }) => id === 'strands-decider');
    assert.ok(darwinStrands);
    assert.equal(darwinStrands.label, 'Strands Decider');
    assert.deepEqual(darwinStrands.devices, ['auto', 'cpu', 'mlx', 'mps']);
    assert.equal(darwinEngines.find(({ id }) => id === 'openai-compatible')?.supported, true);

    const linuxStatus = await setup({ host: LINUX_HOST }).control.status();
    const linuxEngines = linuxStatus['engines'] as {
      id: string;
      label: string;
      description: string;
      tag: string;
      calibrated: boolean;
      capabilities: { validate: boolean };
      devices: string[];
      supported: boolean;
    }[];
    const linuxFlm = linuxEngines.find(({ id }) => id === 'fastflowlm');
    assert.ok(linuxFlm);
    assert.equal(linuxFlm.supported, true);
    assert.equal(linuxFlm.label, 'FastFlowLM (AMD NPU)');
    assert.equal(linuxFlm.description, 'FastFlowLM decision engine for AMD XDNA NPU systems');
    assert.equal(linuxFlm.tag, 'NPU');
    assert.equal(linuxFlm.calibrated, true);
    assert.deepEqual(linuxFlm.capabilities, { validate: true });
    assert.deepEqual(linuxFlm.devices, []);
    const linuxStrands = linuxEngines.find(({ id }) => id === 'strands-decider');
    assert.ok(linuxStrands);
    assert.equal(linuxStrands.label, 'Strands Decider');
    assert.equal(linuxStrands.description, 'strands-decider decision engine');
    assert.equal(linuxStrands.tag, 'PyTorch');
    assert.equal(linuxStrands.calibrated, true);
    assert.deepEqual(linuxStrands.capabilities, { validate: false });
    assert.deepEqual(linuxStrands.devices, ['auto', 'cpu', 'cuda']);

    const configuredOpenAI = await setup({
      host: LINUX_HOST,
      engines: { 'openai-compatible': { url: 'http://127.0.0.1:1/v1', model: 'test-model' } },
    }).control.status();
    const openAI = (configuredOpenAI['engines'] as typeof linuxEngines).find(
      ({ id }) => id === 'openai-compatible',
    );
    assert.ok(openAI);
    assert.equal(
      openAI.description,
      'Score decision options from an OpenAI-compatible server logprob distribution',
    );
    assert.equal(openAI.tag, 'LLM');
    assert.equal(openAI.calibrated, false);
    assert.deepEqual(openAI.capabilities, { validate: false });
  });

  it('dispatches validation using the selected engine descriptor', async () => {
    const { control } = setup();
    const result = await control.validate('fastflowlm');
    assert.equal(result.ok, true);
    assert.deepEqual(result.lines, ['FLM v1.0.12']);

    assert.throws(
      () => control.validate('strands-decider'),
      /strands-decider does not support validation/,
    );
    assert.throws(
      () => control.validate('unknown-engine'),
      /unknown-engine does not support validation/,
    );
  });

  it('validates path updates and refuses them on a remote gateway', async () => {
    const { control, paths } = setup();
    await assert.rejects(control.setPath('tools.flm', 'relative/flm'), /absolute path/);
    await assert.rejects(control.setPath('tools.flm', '/bin/sh'), /named flm/);
    const flm = fakeFlm(paths);
    const entry = await control.setPath('tools.flm', flm);
    assert.equal(entry.source, 'config');
    assert.equal(entry.ok, true);
    assert.equal((await control.setPath('tools.flm', null)).source, 'path');
    const remote = new EngineControl({
      store: new MemoryConfigStore(parseConfig({})),
      paths,
      pathsEditable: false,
      create: (c) => new ModelEngine(c),
    });
    await assert.rejects(remote.setPath('tools.flm', flm), /loopback/);
  });

  it('refuses downloads of unknown or mismatched models', () => {
    const { control } = setup();
    assert.throws(() => control.download('fastflowlm', E2B), /unknown fastflowlm model/);
    assert.throws(() => control.download('strands-decider', '../etc'), /unknown/);
  });
});

describe('request parsing', () => {
  it('parses selections', () => {
    assert.deepEqual(parseSelection({ model: 'm' }), { model: 'm' });
    assert.deepEqual(parseSelection({ engine: 'fastflowlm', model: 'd3:nano' }), {
      engine: 'fastflowlm',
      model: 'd3:nano',
    });
    assert.throws(() => parseSelection({ model: 'm', device: 'gpu' }), EngineSwitchError);
    assert.throws(
      () => parseSelection({ model: 'm', engine: 'systemone-remote' }),
      EngineSwitchError,
    );
    assert.throws(() => parseSelection({}), EngineSwitchError);
  });

  it('parses lifecycle, mode and path updates', () => {
    assert.deepEqual(parseLifecycle({ lifecycle: 'lazy' }), {
      lifecycle: 'lazy',
      idleUnloadMinutes: 15,
    });
    assert.throws(() => parseLifecycle({ lifecycle: 'lazy', idleUnloadMinutes: 0 }), /1\.\.1440/);
    assert.throws(() => parseLifecycle({ lifecycle: 'sometimes' }), EngineSwitchError);
    assert.equal(parseMode({ mode: 'act' }), 'act');
    assert.throws(() => parseMode({ mode: 'yolo' }), EngineSwitchError);
    assert.deepEqual(parseThresholds({ thresholds: { 'verdict.allow': 0.9, 'a.b': null } }), {
      'verdict.allow': 0.9,
      'a.b': null,
    });
    for (const thresholds of [
      undefined,
      [],
      {},
      { 'a.b': 1.5 },
      { 'a.b': '0.5' },
      { 'a.b': -0 - 1 },
    ]) {
      assert.throws(() => parseThresholds({ thresholds }), EngineSwitchError);
    }
    assert.deepEqual(parsePathUpdate({ key: 'tools.flm', value: null }), {
      key: 'tools.flm',
      value: null,
    });
    assert.throws(
      () => parsePathUpdate({ key: 'tools.bash', value: '/bin/bash' }),
      EngineSwitchError,
    );
  });
});

describe('control routes', () => {
  it('serve config.yaml, preset mapping, resolved routes and the authoring prompt', async () => {
    const { control, paths } = setup();
    const gw = await startGateway({ config: testConfig(), paths, engineControl: control, env: {} });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${gw.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const mapped = await post('/v1/routing/presets', {
        harness: 'claude-code',
        preset: 'deep',
        model: 'opus',
      });
      assert.deepEqual(await mapped.json(), {
        harness: 'claude-code',
        presets: { deep: { model: 'opus' } },
      });
      assert.equal(
        (await post('/v1/routing/presets', { harness: 'x', preset: 'deep', model: 'a' })).status,
        400,
      );
      const profiled = await post('/v1/routing/presets', {
        harness: 'paseo',
        preset: 'fast',
        profile: 'implementer-luna',
        thinking: 'xhigh',
      });
      assert.deepEqual(((await profiled.json()) as { presets: unknown }).presets, {
        fast: { profile: 'implementer-luna', thinking: 'xhigh' },
      });
      await post('/v1/routing/presets', { harness: 'paseo', preset: 'fast' });
      assert.equal(
        (
          await post('/v1/routing/presets', {
            harness: 'paseo',
            preset: 'fast',
            thinking: 'x'.repeat(101),
            model: 'a/b',
          })
        ).status,
        400,
      );
      const described = (await (await fetch(`${gw.url}/v1/config`)).json()) as {
        policyDir: string;
        config: { routing: { presets: Record<string, unknown> } };
      };
      assert.equal(described.policyDir, join(paths.config, 'policies'));
      assert.deepEqual(described.config.routing.presets, {
        'claude-code': { deep: { model: 'opus' } },
      });
      await post('/v1/routing/presets', { harness: 'claude-code', preset: 'deep', model: null });
      assert.deepEqual(control.settings.routing.presets, {});

      const prompt = (await (await fetch(`${gw.url}/v1/policies/routing/prompt`)).json()) as {
        prompt: string;
        cwd: string;
      };
      assert.equal(prompt.cwd, paths.config);
      assert.match(prompt.prompt, /variantOf: routing/);
      assert.equal((await fetch(`${gw.url}/v1/policies/permission/prompt`)).status, 400);
      assert.deepEqual(await (await post('/v1/config/reload', {})).json(), {
        changed: false,
        notes: [],
      });
    } finally {
      await gw.close();
    }
  });

  it('answer 409 when the engine cannot switch', async () => {
    const gw = await startGateway({
      config: testConfig(),
      paths: tempPaths(),
      engine: new FakeEngine(),
      env: {},
    });
    try {
      for (const path of ['/v1/engine', '/v1/engine/load', '/v1/policies/permission/mode']) {
        const res = await fetch(`${gw.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: E2B, mode: 'act' }),
        });
        assert.equal(res.status, 409, path);
      }
    } finally {
      await gw.close();
    }
  });

  it('serve engines status, switching, lifecycle and policy modes', async () => {
    const { control, paths } = setup();
    const gw = await startGateway({ config: testConfig(), paths, engineControl: control, env: {} });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${gw.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const status = (await (await fetch(`${gw.url}/v1/engines`)).json()) as Record<
        string,
        unknown
      >;
      assert.ok(Array.isArray(status['models']));
      assert.equal(
        (await post('/v1/engine', { engine: 'fastflowlm', model: 'd3:nano' })).status,
        200,
      );
      assert.equal(
        (await post('/v1/engine/lifecycle', { lifecycle: 'lazy', idleUnloadMinutes: 5 })).status,
        200,
      );
      assert.equal((await post('/v1/policies/permission/mode', { mode: 'act' })).status, 200);
      assert.equal((await post('/v1/policies/nope/mode', { mode: 'act' })).status, 400);
      const thresholds = await post('/v1/policies/permission/thresholds', {
        thresholds: { 'verdict.allow': 0.9 },
      });
      assert.equal(thresholds.status, 200);
      const body = (await thresholds.json()) as { thresholds: { key: string; value: number }[] };
      assert.equal(body.thresholds[0]?.value, 0.9);
      for (const bad of [
        { 'verdict.nope': 0.5 },
        { 'verdict.allow': 2 },
        { 'verdict.allow': 0.3 },
        {},
      ]) {
        const res = await post('/v1/policies/permission/thresholds', { thresholds: bad });
        assert.equal(res.status, 400, JSON.stringify(bad));
      }
      const listed = (await (await fetch(`${gw.url}/v1/policies`)).json()) as {
        id: string;
        thresholds: { key: string; default: number; value: number }[];
      }[];
      const permission = listed.find((p) => p.id === 'permission');
      assert.deepEqual(permission?.thresholds[0], {
        key: 'verdict.allow',
        question: 'verdict',
        answer: 'allow',
        action: 'allow',
        kind: 'minProbability',
        default: 0.95,
        value: 0.9,
        floor: 0.5,
      });
      assert.equal(
        (await post('/v1/models/download', { engine: 'fastflowlm', model: 'nope' })).status,
        400,
      );
      assert.equal((await post('/v1/engine/unload', {})).status, 200);
      const health = (await (await fetch(`${gw.url}/health`)).json()) as Record<string, unknown>;
      assert.equal(health['engine'], 'fastflowlm');
    } finally {
      await gw.close();
    }
  });
});

describe('OpenAI-like persisted selection', () => {
  it('keeps a discovered model chosen earlier, and labels models with format and runtime', async () => {
    const paths = tempPaths();
    const store = new MemoryConfigStore(
      parseConfig({
        engine: { type: 'lmstudio', model: 'configured' },
        selection: { engine: 'lmstudio', model: 'discovered-only' },
      }),
    );
    const control = new EngineControl({
      store,
      paths,
      env: { PATH: '' },
      capabilities: stubCapabilities,
      totalMemory: 1e12,
      installed: async () => new Map(),
      create: (c) => new ModelEngine(c),
      fetch: () =>
        Promise.resolve(
          Response.json({
            data: [
              { id: 'discovered-only', type: 'llm', state: 'loaded', compatibility_type: 'mlx' },
            ],
          }),
        ),
    });
    assert.equal(control.current()?.model, 'discovered-only');
    await control.status();
    await control.refreshDiscovery();
    const status = (await control.status()) as { models: { id: string; label: string }[] };
    assert.equal(
      status.models.find((m) => m.id === 'discovered-only')?.label,
      'discovered-only (MLX)',
    );
  });
});

describe('EngineControl recommendation', () => {
  const NPU_CAPS: HostCapabilities = {
    ...NO_CAPABILITIES,
    npu: { status: 'available', evidence: 'accel0: amdxdna' },
  };

  it('shows unknown-based output first, then the probed recommendation', async () => {
    const { control } = setup({
      host: LINUX_HOST,
      capabilities: () => Promise.resolve(NPU_CAPS),
    });
    assert.equal(recommendationOf(await control.status()), 'strands-decider');
    await settleEventLoop();
    assert.equal(recommendationOf(await control.status()), 'fastflowlm');
  });

  it('discards a probe result that finishes after a retool', async () => {
    const probe = deferred<HostCapabilities>();
    let calls = 0;
    const { control } = setup({
      host: LINUX_HOST,
      capabilities: () => {
        calls += 1;
        return calls === 1 ? probe.promise : Promise.resolve(NO_CAPABILITIES);
      },
    });
    await control.status();
    await control.setPath('tools.uv', null);
    probe.resolve(NPU_CAPS);
    await settleEventLoop();
    assert.equal(recommendationOf(await control.status()), 'strands-decider');
    await settleEventLoop();
    assert.equal(calls, 2);
    assert.equal(recommendationOf(await control.status()), 'strands-decider');
  });
});
