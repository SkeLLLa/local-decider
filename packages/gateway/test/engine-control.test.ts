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
import { describe, it, type TestContext } from 'node:test';
import { stringify } from 'yaml';

import type { BenchmarkHost, BenchmarkLease } from '../src/benchmark-job.ts';
import {
  BENCH_VERSION,
  MemoryBenchmarkStore,
  type BenchmarkRecord,
  type BenchmarkStore,
} from '../src/benchmark-store.ts';
import { ConfigFile, MemoryConfigStore } from '../src/config-file.ts';
import { parseConfig, type EngineConfig } from '../src/config.ts';
import { Decider } from '../src/decider.ts';
import { EngineBusyError } from '../src/engine-busy.ts';
import {
  EngineControl,
  EngineSwitchError,
  parseLifecycle,
  parseMode,
  parsePathUpdate,
  parseSelection,
  parseThresholds,
} from '../src/engine-control.ts';
import { FallbackPolicy } from '../src/engine-fallback.ts';
import type { HostInfo } from '../src/engines/descriptor.ts';
import { hardwareFingerprint } from '../src/engines/fingerprint.ts';
import type { HostCapabilities } from '../src/engines/host-capabilities.ts';
import type { Engine, EngineHealth } from '../src/engines/types.ts';
import type { Paths } from '../src/paths.ts';
import { defaultPolicyDir, loadPolicies, policyDirs } from '../src/policies.ts';
import { startGateway } from '../src/runtime.ts';
import {
  FakeEngine,
  controlHeaders,
  NO_CAPABILITIES,
  stubCapabilities,
  tempLog,
  tempPaths,
  testConfig,
} from './helpers.ts';

/** Shared switches of the fake engines: report `failed`, report `ready`, fail on the next decision. */
interface Flags {
  on: boolean;
  ready?: boolean;
  breakOnDecide?: boolean;
}

class ModelEngine implements Engine {
  readonly id: string;
  readonly model: string;
  readonly config: EngineConfig;
  started = 0;
  stopped = 0;
  readonly #failing: Flags | undefined;
  constructor(config: EngineConfig, failing?: Flags) {
    this.config = config;
    this.id = config.type;
    this.model = config.model;
    this.#failing = failing;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  health(): EngineHealth {
    if (this.#failing?.on === true) {
      return { state: 'failed', model: this.model, detail: 'boom' };
    }
    return { state: this.#failing?.ready === true ? 'ready' : 'starting', model: this.model };
  }
  async decide(): Promise<never> {
    if (this.#failing?.breakOnDecide === true) {
      this.#failing.on = true;
    }
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

function fakeLlama(paths: Paths): void {
  const binary = join(binDir(paths), 'llama-server');
  writeFileSync(binary, `#!${process.execPath}\n`);
  chmodSync(binary, 0o755);
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
  readonly selection?: Record<string, unknown>;
  readonly engines?: Record<string, unknown>;
  readonly totalMemory?: number;
  readonly installed?: boolean;
  readonly paths?: Paths;
  readonly capabilities?: () => Promise<HostCapabilities>;
  readonly persist?: boolean;
  readonly host?: HostInfo;
  readonly benchmarkStore?: BenchmarkStore;
  readonly llamaServer?: boolean;
  /** While `on`, every engine reports `failed`; with `ready`, `ready` instead of `starting`. */
  readonly failing?: Flags;
  readonly preemptCapMs?: number;
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

const VULKAN_CAPABILITIES: HostCapabilities = {
  ...NO_CAPABILITIES,
  vulkan: { status: 'available', evidence: 'Vulkan0: test GPU' },
};

function setup(options: SetupOptions = {}): Setup {
  const paths = options.paths ?? tempPaths();
  fakeFlm(paths);
  fakeStrands(paths);
  if (options.llamaServer === true) fakeLlama(paths);
  const store =
    options.persist === true
      ? ConfigFile.open(paths)
      : new MemoryConfigStore(
          parseConfig({
            engine: { type: 'strands-decider', ...options.engine },
            ...(options.selection === undefined ? {} : { selection: options.selection }),
          }),
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
    ...(options.benchmarkStore === undefined ? {} : { benchmarkStore: options.benchmarkStore }),
    ...(options.preemptCapMs === undefined ? {} : { preemptCapMs: options.preemptCapMs }),
    create: (c) => {
      const next = new ModelEngine(c, options.failing);
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

function measuredRecord(
  engine: 'fastflowlm' | 'llama-vulkan',
  model: string,
  p50Ms: number,
  fingerprint: string,
): BenchmarkRecord {
  const fastflow = engine === 'fastflowlm';
  return {
    jobId: `lease-${engine}-${String(p50Ms)}`,
    engine,
    model,
    device: null,
    family: 'vllm-sr/d3-mini',
    quant: fastflow ? 'FLM' : 'Q4_K_M',
    status: 'ok',
    error: null,
    measuredAt: '2026-11-12T10:04:11.000Z',
    benchVersion: BENCH_VERSION,
    gatewayVersion: '2.0.0',
    runtime: null,
    modelStamp: null,
    fingerprint,
    backend: fastflow ? 'NPU' : 'Vulkan',
    resolvedDevice: null,
    runs: 5,
    loadMs: 1,
    sizes: [
      {
        targetTokens: 1024,
        inputTokens: 1024,
        p50Ms,
        p95Ms: p50Ms + 100,
        answer: 'done',
        error: null,
      },
    ],
  };
}

/** Compile-time check: the control implements the lease methods of the runner's host. */
const hostSeam = (
  control: EngineControl,
): Pick<BenchmarkHost, 'beginBenchmark' | 'benchmarkSwap' | 'endBenchmark'> => control;

describe('EngineControl benchmark lease', () => {
  it('fits the runner host seam and refuses a lease it did not issue', async () => {
    const { control } = setup();
    const host = hostSeam(control);
    const foreign = {
      signal: new AbortController().signal,
      abort: () => undefined,
      preempted: null,
      done: Promise.resolve(),
      snapshot: {
        mode: 'auto',
        selection: { engine: 'strands-decider', model: E2B, device: null },
        family: null,
      },
    } as const;
    assert.deepEqual(await host.endBenchmark(foreign, { restore: false }), {
      ok: false,
      error: 'benchmark lease is no longer active',
    });
    const lease = host.beginBenchmark();
    assert.equal(lease.signal.aborted, false);
    lease.abort('user');
    assert.equal(lease.signal.aborted, true);
    await assert.rejects(
      host.benchmarkSwap(lease, { engine: 'strands-decider', model: E2B, device: 'cpu' }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    );
    await host.endBenchmark(lease, { restore: false });
  });

  it('holds decisions through an unpersisted swap and restores the exact manual selection', async () => {
    const { control, decider, created } = setup();
    const selection = control.current();
    assert.ok(selection);
    const configBefore = stringify(control.settings);
    const lease = control.beginBenchmark();
    assert.equal(lease.snapshot.mode, 'manual');
    assert.deepEqual(lease.snapshot.selection, selection);
    await assert.rejects(
      decider.systemOne({ state: 's', questions: {} }, new AbortController().signal),
      /engine benchmark running/,
    );

    const swapped = await control.benchmarkSwap(lease, {
      engine: 'strands-decider',
      model: E2B,
      device: 'cpu',
    });
    assert.equal(typeof swapped.decide, 'function');
    assert.equal(swapped.health().resolvedDevice ?? 'cpu', 'cpu');
    assert.equal(control.current()?.model, E2B);
    assert.equal(stringify(control.settings), configBefore);

    const restore = deferred<void>();
    created[1]!.stop = () => restore.promise;
    const ending = control.endBenchmark(lease, { restore: true });
    await settleEventLoop();
    await assert.rejects(
      decider.systemOne({ state: 's', questions: {} }, new AbortController().signal),
      /engine benchmark running/,
    );
    restore.resolve();
    assert.deepEqual(await ending, { ok: true, error: null });
    await lease.done;
    assert.deepEqual(control.current(), selection);
    assert.equal(stringify(control.settings), configBefore);
    await assert.rejects(
      decider.systemOne({ state: 's', questions: {} }, new AbortController().signal),
      (error: unknown) => !(error instanceof EngineBusyError),
    );
  });

  it('rejects a second lease and keeps the decision hold after a non-restoring end', async () => {
    const { control, decider } = setup();
    const lease = control.beginBenchmark();
    assert.throws(
      () => control.beginBenchmark(),
      (error: unknown) => error instanceof EngineSwitchError && error.status === 409,
    );
    assert.deepEqual(await control.endBenchmark(lease, { restore: false }), {
      ok: true,
      error: null,
    });
    await lease.done;
    await assert.rejects(
      decider.systemOne({ state: 's', questions: {} }, new AbortController().signal),
      /engine benchmark running/,
    );
    await assert.rejects(
      control.benchmarkSwap(lease, {
        engine: 'strands-decider',
        model: E2B,
        device: 'cpu',
      }),
      { name: 'AbortError' },
    );
  });

  it('re-ranks automatic mode after a benchmark and keeps the preferred family', async () => {
    const family = 'vllm-sr/d3-mini';
    const capabilities: HostCapabilities = {
      ...NO_CAPABILITIES,
      npu: { status: 'available', evidence: 'accel0: benchmark test' },
      vulkan: { status: 'available', evidence: 'Vulkan0: benchmark test' },
    };
    const fingerprint = hardwareFingerprint(
      { ...LINUX_HOST, totalMemoryBytes: 1e12 },
      capabilities,
    );
    assert.ok(fingerprint);
    const benchmarks = new MemoryBenchmarkStore();
    benchmarks.append(measuredRecord('fastflowlm', 'd3:mini', 300, fingerprint));
    benchmarks.append(measuredRecord('llama-vulkan', 'd3-mini-q4_k_m', 500, fingerprint));
    const { control } = setup({
      selection: { mode: 'auto', family },
      host: LINUX_HOST,
      capabilities: () => Promise.resolve(capabilities),
      benchmarkStore: benchmarks,
      llamaServer: true,
    });
    await control.reconcileAuto();
    assert.equal(control.current()?.engine, 'fastflowlm');
    const configBefore = stringify(control.settings);

    const lease = control.beginBenchmark();
    await control.benchmarkSwap(lease, {
      engine: 'strands-decider',
      model: E2B,
      device: 'cpu',
    });
    benchmarks.append(measuredRecord('llama-vulkan', 'd3-mini-q4_k_m', 100, fingerprint));
    assert.deepEqual(await control.endBenchmark(lease, { restore: true }), {
      ok: true,
      error: null,
    });
    await lease.done;

    assert.equal(control.current()?.engine, 'llama-vulkan');
    assert.equal(control.current()?.model, 'd3-mini-q4_k_m');
    assert.deepEqual(control.settings.selection, { mode: 'auto', family });
    assert.equal(stringify(control.settings), configBefore);
  });
});

async function automaticControl(t: TestContext): Promise<{
  control: EngineControl;
  failing: Flags;
  probes: { capabilities: number };
  spies: { success: number; failure: number; retry: number };
  counts: () => { success: number; failure: number; retry: number };
}> {
  const failing: Flags = { on: false };
  const probes = { capabilities: 0 };
  const { control } = setup({
    selection: { mode: 'auto' },
    failing,
    capabilities: async () => {
      probes.capabilities += 1;
      return stubCapabilities();
    },
  });
  await control.reconcileAuto();
  await control.idle();
  await settleEventLoop();
  const success = t.mock.method(FallbackPolicy.prototype, 'recordSuccess');
  const failure = t.mock.method(FallbackPolicy.prototype, 'recordFailure');
  const retry = t.mock.method(FallbackPolicy.prototype, 'nextRetryAt');
  const counts = (): { success: number; failure: number; retry: number } => ({
    success: success.mock.callCount(),
    failure: failure.mock.callCount(),
    retry: retry.mock.callCount(),
  });
  return { control, failing, probes, spies: counts(), counts };
}

async function fallbackOf(control: EngineControl): Promise<unknown> {
  return ((await control.status())['active'] as Record<string, unknown>)['fallback'];
}

describe('EngineControl benchmark accounting', () => {
  const BENCH_TARGET = { engine: 'strands-decider', model: E2B, device: 'cpu' } as const;

  it('a leased engine that starts does not feed the fallback policy or queue a reconcile', async (t) => {
    const { control, failing, probes, spies, counts } = await automaticControl(t);
    const probed = probes.capabilities;
    const lease = control.beginBenchmark();
    failing.ready = true;
    await control.benchmarkSwap(lease, BENCH_TARGET);
    await settleEventLoop();
    assert.deepEqual(counts(), spies);
    assert.equal(probes.capabilities, probed);
    await control.reconcileAuto();
    assert.equal(probes.capabilities, probed);
    assert.equal(await fallbackOf(control), undefined);
    assert.deepEqual(counts(), spies);
    await control.endBenchmark(lease, { restore: false });
  });

  it('a leased engine that fails records no failure, no note and arms no retry', async (t) => {
    const { control, failing, probes, spies, counts } = await automaticControl(t);
    const probed = probes.capabilities;
    const lease = control.beginBenchmark();
    failing.on = true;
    await control.benchmarkSwap(lease, BENCH_TARGET);
    await settleEventLoop();
    await control.idle();
    assert.equal(control.activeHealth().state, 'failed');
    assert.deepEqual(counts(), spies);
    assert.equal(probes.capabilities, probed);
    assert.equal(await fallbackOf(control), undefined);
    await control.endBenchmark(lease, { restore: false });
  });

  it('accounts for failures again once the restore has installed a normal engine', async (t) => {
    const { control, failing, spies, counts } = await automaticControl(t);
    const lease = control.beginBenchmark();
    await control.benchmarkSwap(lease, BENCH_TARGET);
    await settleEventLoop();
    assert.deepEqual(counts(), spies);
    failing.on = true;
    assert.deepEqual(await control.endBenchmark(lease, { restore: true }), {
      ok: true,
      error: null,
    });
    await lease.done;
    await control.idle();
    await settleEventLoop();
    // Accounting resumed: the failure was recorded against the restored engine's candidate.
    assert.ok(counts().failure > spies.failure);
    assert.equal(control.activeHealth().state, 'failed');
    // `active.fallback` is not asserted: this fake fails the instant `start()` resolves, which is
    // before the reconcile that installed it clears its own note (the same happens without any
    // benchmark). A real engine fails later, after that reconcile has returned.
  });
});

const REFUSED = (error: unknown): boolean =>
  error instanceof EngineSwitchError &&
  error.status === 409 &&
  error.message === 'an engine benchmark is running; cancel it first';

const connection = {
  engine: 'lmstudio',
  url: 'http://127.0.0.1:1234/v1',
  model: 'qwen',
  tokenEnv: undefined,
} as const;

describe('EngineControl benchmark guards', () => {
  it('refuses load, unload, lifecycle, paths and connection changes during a lease, and allows them after', async () => {
    const { control } = setup();
    const lease = control.beginBenchmark();
    await assert.rejects(control.load(), REFUSED);
    await assert.rejects(control.unload(), REFUSED);
    assert.throws(
      () => control.setLifecycle({ lifecycle: 'eager', idleUnloadMinutes: 30 }),
      REFUSED,
    );
    await assert.rejects(control.setPath('tools.flm', null), REFUSED);
    await assert.rejects(control.saveEngineConnection(connection), REFUSED);
    assert.equal(control.settings.lifecycle.mode, 'lazy');

    await control.endBenchmark(lease, { restore: false });
    await control.load();
    await control.unload();
    assert.deepEqual(control.setLifecycle({ lifecycle: 'eager', idleUnloadMinutes: 30 }), {
      lifecycle: 'eager',
      idleUnloadMinutes: 30,
    });
    assert.equal((await control.setPath('tools.flm', null)).value, null);
    assert.equal((await control.saveEngineConnection(connection)).model, 'qwen');
  });

  it('still allows downloads, validation, status and policy changes during a lease', async () => {
    const { control } = setup();
    const lease = control.beginBenchmark();
    assert.throws(() => control.download('fastflowlm', E2B), /unknown fastflowlm model/);
    assert.equal((await control.validate('fastflowlm')).ok, true);
    assert.ok((await control.status())['active']);
    control.setPolicyMode('routing', 'shadow');
    await control.endBenchmark(lease, { restore: false });
  });
});

const TWOB = 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610';

/** What the benchmark runner does when its lease is aborted: wait for `gate`, then end it. */
function endingRunner(
  control: EngineControl,
  lease: BenchmarkLease,
  gate: Promise<void>,
): Promise<void> {
  return (async () => {
    await new Promise<void>((resolve) => {
      if (lease.signal.aborted) resolve();
      lease.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await gate;
    await control.endBenchmark(lease, { restore: false });
  })();
}

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError';

async function isHeld(decider: Decider): Promise<boolean> {
  try {
    await decider.systemOne({ state: 's', questions: {} }, new AbortController().signal);
  } catch (error) {
    return error instanceof EngineBusyError;
  }
  return false;
}

/** Record every hold change with the state of the control at that moment. */
function watchHolds(
  t: TestContext,
  control: EngineControl,
  decider: Decider,
  created: readonly unknown[],
): { reason: string | null; model: string | undefined; engines: number }[] {
  const holds: { reason: string | null; model: string | undefined; engines: number }[] = [];
  const hold = decider.hold.bind(decider);
  t.mock.method(decider, 'hold', (reason: string | null) => {
    holds.push({ reason, model: control.current()?.model, engines: created.length });
    hold(reason);
  });
  return holds;
}

/** The hold releases: each must come after the user's engine is installed. */
function releases<T extends { reason: string | null }>(holds: readonly T[]): T[] {
  return holds.filter((h) => h.reason === null);
}

describe('EngineControl benchmark preemption', () => {
  it('select() aborts the job, waits for it to end, installs its engine, then releases the hold', async (t) => {
    const { control, decider, created } = setup();
    const holds = watchHolds(t, control, decider, created);
    const lease = control.beginBenchmark();
    await control.benchmarkSwap(lease, { engine: 'strands-decider', model: E2B, device: 'cpu' });
    const gate = deferred<void>();
    const runner = endingRunner(control, lease, gate.promise);

    const selecting = control.select({ model: TWOB, device: 'cpu' });
    await settleEventLoop();
    assert.equal(lease.signal.aborted, true);
    assert.equal(lease.preempted, 'superseded');
    assert.equal(control.current()?.model, E2B, 'the user engine waits for the runner');
    assert.equal(await isHeld(decider), true);
    await assert.rejects(
      control.benchmarkSwap(lease, { engine: 'strands-decider', model: TWOB, device: 'cpu' }),
      isAbort,
    );

    gate.resolve();
    await selecting;
    await runner;
    assert.equal(control.current()?.model, TWOB);
    assert.equal(created.length, 3, 'no benchmark engine is built after the select');
    assert.deepEqual(releases(holds), [{ reason: null, model: TWOB, engines: 3 }]);
    assert.equal(await isHeld(decider), false);
    await assert.rejects(
      control.benchmarkSwap(lease, { engine: 'strands-decider', model: E2B, device: 'cpu' }),
      isAbort,
    );
    assert.equal(created.length, 3);
  });

  it('a config.yaml change of the selection preempts the same way', async (t) => {
    const paths = tempPaths();
    const { control, decider, created } = setup({ paths, persist: true });
    const holds = watchHolds(t, control, decider, created);
    const lease = control.beginBenchmark();
    await control.benchmarkSwap(lease, { engine: 'strands-decider', model: E2B, device: 'cpu' });
    const gate = deferred<void>();
    const runner = endingRunner(control, lease, gate.promise);

    ConfigFile.open(paths).update([
      { path: ['selection'], value: { engine: 'strands-decider', model: TWOB, device: 'cpu' } },
    ]);
    const reloading = control.reloadConfig();
    await settleEventLoop();
    assert.equal(lease.preempted, 'config-changed');
    assert.equal(control.current()?.model, E2B);
    assert.equal(await isHeld(decider), true);

    gate.resolve();
    await reloading;
    await runner;
    assert.equal(control.current()?.model, TWOB);
    assert.deepEqual(releases(holds), [{ reason: null, model: TWOB, engines: 3 }]);
    assert.equal(await isHeld(decider), false);
  });

  it('a policy-only change leaves the job alone', async () => {
    const paths = tempPaths();
    const { control, decider } = setup({ paths, persist: true });
    const lease = control.beginBenchmark();
    await control.benchmarkSwap(lease, { engine: 'strands-decider', model: E2B, device: 'cpu' });
    ConfigFile.open(paths).update([{ path: ['policies', 'routing', 'mode'], value: 'act' }]);
    await control.reloadConfig();
    assert.equal(lease.signal.aborted, false);
    assert.equal(lease.preempted, null);
    assert.equal(control.current()?.model, E2B);
    assert.equal(decider.policies.get('routing')?.mode, 'act');
    assert.equal(await isHeld(decider), true);
    assert.throws(() => control.beginBenchmark(), /already running/);
    await control.endBenchmark(lease, { restore: false });
  });

  it('proceeds past the cap when the runner never ends, and late benchmark calls are inert', async (t) => {
    const { control, decider, created } = setup({ preemptCapMs: 30 });
    const holds = watchHolds(t, control, decider, created);
    const lease = control.beginBenchmark();
    await control.benchmarkSwap(lease, { engine: 'strands-decider', model: E2B, device: 'cpu' });

    await control.select({ model: TWOB, device: 'cpu' });
    assert.equal(control.current()?.model, TWOB);
    assert.deepEqual(releases(holds), [{ reason: null, model: TWOB, engines: 3 }]);
    assert.equal(await isHeld(decider), false);
    await assert.rejects(
      control.benchmarkSwap(lease, { engine: 'strands-decider', model: E2B, device: 'cpu' }),
      isAbort,
    );
    assert.deepEqual(await control.endBenchmark(lease, { restore: false }), {
      ok: false,
      error: 'benchmark lease is no longer active',
    });
    assert.equal(created.length, 3);
    assert.equal(control.current()?.model, TWOB);
  });

  it('keeps accounting when the preempting change keeps the same engine instance', async (t) => {
    const failing: Flags = { on: false };
    const { control, decider, created } = setup({ selection: { mode: 'auto' }, failing });
    await control.reconcileAuto();
    await control.idle();
    await settleEventLoop();
    const selected = control.current();
    assert.ok(selected);
    const failure = t.mock.method(FallbackPolicy.prototype, 'recordFailure');
    const engines = created.length;

    const lease = control.beginBenchmark();
    await control.benchmarkSwap(lease, selected);
    const gate = deferred<void>();
    const runner = endingRunner(control, lease, gate.promise);
    const switching = control.setSelectionMode('auto');
    await settleEventLoop();
    gate.resolve();
    await switching;
    await runner;
    assert.equal(created.length, engines, 'the leased engine is still the installed one');
    assert.equal(await isHeld(decider), false);

    failing.ready = true;
    failing.breakOnDecide = true;
    // A decision on the engine that now fails reports it, as a real failure would.
    await decider.decide(
      'permission',
      {
        harness: 'cli',
        input: { project: '/p', tool: 'Bash', request: { command: 'ls' }, history: 'user: ls' },
      },
      new AbortController().signal,
    );
    assert.ok(failure.mock.callCount() > 0, 'a failure of that engine is accounted again');
  });
});

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
        /at least 0.8/.test(error.message),
    );
    assert.equal(
      first.control.setPolicyThresholds('permission', {
        'verdict.allow': 0.8,
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
      0.8,
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
      ['strands-decider', 'fastflowlm', 'llama-vulkan', 'openai-compatible', 'lmstudio'],
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

  it('uses a llama-vulkan binary set only in engine config for availability, ranking and selection', async () => {
    const paths = tempPaths();
    const fake = join(paths.data, 'custom', 'my-llama');
    mkdirSync(join(fake, '..'), { recursive: true });
    writeFileSync(fake, `#!${process.execPath}\n`);
    chmodSync(fake, 0o755);
    const { control, created } = setup({
      paths,
      host: LINUX_HOST,
      capabilities: async () => VULKAN_CAPABILITIES,
      engines: { 'llama-vulkan': { binary: fake } },
    });
    await control.status();
    await settleEventLoop();
    const status = await control.status();
    const row = (
      status['engines'] as { id: string; installed: boolean; available: boolean; detail: string }[]
    ).find((engine) => engine.id === 'llama-vulkan');
    assert.deepEqual([row?.installed, row?.available, row?.detail], [true, true, fake]);
    assert.equal(recommendationOf(status), 'llama-vulkan');
    await control.select({ engine: 'llama-vulkan', model: 'd3-lite-q8_0' });
    assert.equal(created.at(-1)?.config.type, 'llama-vulkan');
  });

  it('treats a configured llama-vulkan URL as available without a binary or local model', async () => {
    const url = 'http://127.0.0.1:1234';
    const { control, created } = setup({
      host: LINUX_HOST,
      capabilities: async () => VULKAN_CAPABILITIES,
      engines: { 'llama-vulkan': { url } },
    });
    await control.status();
    await settleEventLoop();
    const readyStatus = await control.status();
    const row = (
      readyStatus['engines'] as {
        id: string;
        installed: boolean;
        available: boolean;
        detail: string;
      }[]
    ).find((engine) => engine.id === 'llama-vulkan');
    assert.deepEqual(
      [row?.installed, row?.available, row?.detail],
      [true, true, 'Attached via engines.llama-vulkan.url'],
    );
    assert.equal(recommendationOf(readyStatus), 'llama-vulkan');
    await control.select({ engine: 'llama-vulkan', model: 'd3-lite-q8_0' });
    assert.deepEqual(
      [created.at(-1)?.config.type, created.at(-1)?.config.url],
      ['llama-vulkan', url],
    );
  });

  it('keeps llama-vulkan unavailable and refuses selection without a binary', async () => {
    const { control } = setup({ host: LINUX_HOST, capabilities: async () => VULKAN_CAPABILITIES });
    const status = await control.status();
    const row = (
      status['engines'] as {
        id: string;
        installed: boolean;
        available: boolean;
        installUrl?: string;
      }[]
    ).find((engine) => engine.id === 'llama-vulkan');
    assert.deepEqual(
      [row?.installed, row?.available, row?.installUrl],
      [false, false, 'https://github.com/ggml-org/llama.cpp/releases'],
    );
    assert.equal(recommendationOf(status), 'strands-decider');
    await assert.rejects(
      control.select({ engine: 'llama-vulkan', model: 'd3-lite-q8_0' }),
      (error: unknown) => error instanceof EngineSwitchError && error.status === 409,
    );
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
      ['strands-decider', 'fastflowlm', 'llama-vulkan', 'openai-compatible', 'lmstudio'],
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
  it('accepts the bearer in token mode and still requires it for control routes', async () => {
    const { control, paths } = setup();
    const bearer = 'remote-bearer';
    const gw = await startGateway({
      config: testConfig(),
      paths,
      engineControl: control,
      env: { LOCAL_DECIDER_TOKEN: bearer },
    });
    try {
      assert.equal(
        (await fetch(`${gw.url}/v1/config`, { headers: { authorization: `Bearer ${bearer}` } }))
          .status,
        200,
      );
      assert.equal(
        (await fetch(`${gw.url}/v1/config`, { headers: controlHeaders(paths) })).status,
        401,
      );
    } finally {
      await gw.close();
    }
  });

  it('serve config.yaml, preset mapping, resolved routes and the authoring prompt', async () => {
    const { control, paths } = setup();
    const gw = await startGateway({ config: testConfig(), paths, engineControl: control, env: {} });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${gw.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...controlHeaders(paths) },
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
      const described = (await (
        await fetch(`${gw.url}/v1/config`, { headers: controlHeaders(paths) })
      ).json()) as {
        policyDir: string;
        config: { routing: { presets: Record<string, unknown> } };
      };
      assert.equal(described.policyDir, join(paths.config, 'policies'));
      assert.deepEqual(described.config.routing.presets, {
        'claude-code': { deep: { model: 'opus' } },
      });
      await post('/v1/routing/presets', { harness: 'claude-code', preset: 'deep', model: null });
      assert.deepEqual(control.settings.routing.presets, {});

      const prompt = (await (
        await fetch(`${gw.url}/v1/policies/routing/prompt`, { headers: controlHeaders(paths) })
      ).json()) as {
        prompt: string;
        cwd: string;
      };
      assert.equal(prompt.cwd, paths.config);
      assert.match(prompt.prompt, /variantOf: routing/);
      assert.equal(
        (await fetch(`${gw.url}/v1/policies/permission/prompt`, { headers: controlHeaders(paths) }))
          .status,
        400,
      );
      assert.deepEqual(await (await post('/v1/config/reload', {})).json(), {
        changed: false,
        notes: [],
      });
      assert.equal((await post('/v1/policies/reload', {})).status, 200);
    } finally {
      await gw.close();
    }
  });

  it('answer 409 when the engine cannot switch', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine(),
      env: {},
    });
    try {
      for (const path of ['/v1/engine', '/v1/engine/load', '/v1/policies/permission/mode']) {
        const res = await fetch(`${gw.url}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...controlHeaders(paths) },
          body: JSON.stringify({ model: E2B, mode: 'act' }),
        });
        assert.equal(res.status, 409, path);
      }
    } finally {
      await gw.close();
    }
  });

  it('serve engines status, switching, lifecycle and policy modes', async () => {
    const npuCapabilities: HostCapabilities = {
      ...NO_CAPABILITIES,
      npu: { status: 'available', evidence: 'accel0: amdxdna' },
    };
    const { control, paths } = setup({
      host: LINUX_HOST,
      capabilities: () => Promise.resolve(npuCapabilities),
    });
    const gw = await startGateway({ config: testConfig(), paths, engineControl: control, env: {} });
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${gw.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...controlHeaders(paths) },
        body: JSON.stringify(body),
      });
    try {
      const status = (await (
        await fetch(`${gw.url}/v1/engines`, { headers: controlHeaders(paths) })
      ).json()) as Record<string, unknown>;
      assert.ok(Array.isArray(status['models']));
      assert.equal(
        (await post('/v1/engine', { engine: 'fastflowlm', model: 'd3:nano' })).status,
        200,
      );
      const automatic = await post('/v1/engine/mode', {
        mode: 'auto',
        family: 'vllm-sr/d3-mini',
      });
      assert.equal(automatic.status, 200);
      assert.deepEqual(await automatic.json(), { mode: 'auto' });
      const manualFamily = await post('/v1/engine/mode', {
        mode: 'manual',
        family: 'vllm-sr/d3-mini',
      });
      assert.equal(manualFamily.status, 400);
      assert.deepEqual(await manualFamily.json(), {
        error: 'family applies to automatic mode only',
      });
      const unknownFamily = await post('/v1/engine/mode', {
        mode: 'auto',
        family: 'unknown-family',
      });
      assert.equal(unknownFamily.status, 400);
      assert.deepEqual(await unknownFamily.json(), {
        error: 'unknown model family "unknown-family"',
      });
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
        floor: 0.8,
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

describe('EngineControl benchmark status', () => {
  it('adds family, format and cached measurements to catalogue models', async () => {
    const benchmarks = new MemoryBenchmarkStore();
    const record: BenchmarkRecord = {
      jobId: 'bench-1',
      engine: 'llama-vulkan',
      model: 'd3-mini-q4_k_m',
      device: null,
      family: 'vllm-sr/d3-mini',
      quant: 'Q4_K_M',
      status: 'ok',
      error: null,
      measuredAt: '2026-11-12T10:04:11.000Z',
      benchVersion: BENCH_VERSION,
      gatewayVersion: '2.0.0',
      runtime: null,
      modelStamp: 'sha256:fixture',
      fingerprint: '0123456789abcdef',
      backend: 'Vulkan',
      resolvedDevice: null,
      runs: 2,
      loadMs: 10,
      sizes: [
        {
          targetTokens: 1024,
          inputTokens: 1000,
          p50Ms: 460,
          p95Ms: 529,
          answer: 'done',
          error: null,
        },
      ],
    };
    benchmarks.append(record);
    const { control } = setup({ benchmarkStore: benchmarks });
    const status = await control.status();
    const models = status['models'] as {
      id: string;
      engine: string;
      family: { id: string; label: string } | null;
      format: { short: string; label: string } | null;
      measured: { runs: number; provisional: boolean; freshness: string }[];
    }[];
    const model = models.find(
      (entry) => entry.id === record.model && entry.engine === record.engine,
    );
    assert.deepEqual(model?.family, { id: record.family, label: 'd3 mini' });
    assert.deepEqual(model?.format, { short: 'Q4_K_M', label: '4-bit (Q4_K_M)' });
    assert.deepEqual(model?.measured[0], {
      device: null,
      typical: { p50Ms: 460, p95Ms: 529 },
      long: null,
      sizes: [{ targetTokens: 1024, inputTokens: 1000, p50Ms: 460, p95Ms: 529 }],
      runs: 2,
      provisional: true,
      measuredAt: record.measuredAt,
      freshness: 'unknown',
      staleReason: null,
      failed: null,
    });
    const engines = status['engines'] as { id: string; version: string | null }[];
    assert.equal('version' in (engines.find((entry) => entry.id === 'llama-vulkan') ?? {}), true);
    const active = status['active'] as { preferredFamily: string | null };
    assert.equal(typeof active.preferredFamily, 'string');
  });
});
