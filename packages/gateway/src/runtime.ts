import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';

import { ConfigFile, MemoryConfigStore, type ConfigStore } from './config-file.ts';
import { isLoopback, type GatewayConfig } from './config.ts';
import { Decider } from './decider.ts';
import { EngineControl } from './engine-control.ts';
import type { Engine } from './engines/types.ts';
import type { LogStore } from './log-store.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs, type LoadedPolicy } from './policies.ts';
import { ensureReportToken } from './report-token.ts';
import { writeSchemas } from './schemas.ts';
import { createGatewayServer, type ServerOptions } from './server.ts';
import { openLogStore } from './sqlite-log.ts';
import { StatsService } from './stats-service.ts';

export interface Gateway {
  readonly server: Server;
  readonly decider: Decider;
  readonly url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Startup settings (host and port may carry command-line overrides). */
  readonly config: GatewayConfig;
  /** Where settings changes go; a `ConfigFile` is also watched. Default: in memory only. */
  readonly store?: ConfigStore;
  /** Diagnostics for settings reloads. */
  readonly log?: (line: string) => void;
  readonly paths: Paths;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected in tests; otherwise built from `config.engine` (and the saved selection). */
  readonly engine?: Engine;
  /** Injected in tests: a prepared engine control (with fakes). */
  readonly engineControl?: EngineControl;
  readonly policies?: ReadonlyMap<string, LoadedPolicy>;
  /** Injected storage; otherwise SQLite under the data directory. */
  readonly logStore?: LogStore;
}

/** Stats run in a worker when the log is the SQLite file; an injected store computes in-process. */
function statsService(options: StartOptions, log: LogStore): StatsService {
  return new StatsService({
    log,
    paths: options.logStore === undefined ? options.paths : undefined,
  });
}

/** A managed engine starts through EngineControl, which in auto mode lets the first reconcile pick it. */
function startEngine(engine: Engine, engineControl: EngineControl | undefined): void {
  if (engineControl !== undefined && engine === engineControl.engine) {
    engineControl.start();
  } else {
    void engine.start();
  }
}

/**
 * Listen first, then start the engine in the background: `/health` reports `degraded` while
 * the model loads, so adapters can skip decisions instead of waiting minutes.
 */
export async function startGateway(options: StartOptions): Promise<Gateway> {
  const { config, paths } = options;
  const env = options.env ?? process.env;
  const report = options.log ?? NOOP;
  const token = env['LOCAL_DECIDER_TOKEN'];
  checkBinding(config.host, token);
  const hasToken = token !== undefined && token !== '';
  const store = options.store ?? new MemoryConfigStore(config);
  // An injected engine (tests) is not rebuilt from config, so it cannot be switched.
  const engineControl =
    options.engineControl ??
    (options.engine === undefined
      ? new EngineControl({ store, paths, env, pathsEditable: !hasToken })
      : undefined);
  const engine = options.engine ?? (engineControl as EngineControl).engine;
  const reportToken = ensureReportToken(paths);
  const policies = options.policies ?? loadPolicies(config, policyDirs(config, paths));
  const log = options.logStore ?? openLogStore(paths);
  pruneLogs(log, config.logs.retainDays, report);
  const decider = new Decider({
    engine,
    policies,
    log,
    decisionTimeoutMs: config.decisionTimeoutMs,
  });
  decider.rebuildPrecedent();
  engineControl?.bind(decider);
  const stats = statsService(options, log);
  const server = await listenGatewayServer(log, config.host, config.port, {
    report,
    decider,
    log,
    token: hasToken ? token : undefined,
    reportToken,
    engineControl,
    pricing: config.pricing,
    stats,
    settings: () => engineControl?.settings ?? store.current,
  });
  startEngine(engine, engineControl);
  const unwatch =
    store instanceof ConfigFile && engineControl !== undefined
      ? watchSettings(store, engineControl, report)
      : NOOP;
  const stopPruning = scheduleLogPruning(log, store, report);
  const { port } = server.address() as AddressInfo;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return {
    server,
    decider,
    url: `http://${host}:${String(port)}`,
    async close() {
      unwatch();
      stopPruning();
      await engineControl?.idle();
      await decider.engine.stop();
      stats.close();
      closeLogStore(log);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function pruneLogs(log: LogStore, retainDays: number, report: (line: string) => void): void {
  try {
    log.prune(retainDays);
  } catch (error) {
    report(`log retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleLogPruning(
  log: LogStore,
  store: ConfigStore,
  report: (line: string) => void,
): () => void {
  const interval = setInterval(
    () => pruneLogs(log, store.current.logs.retainDays, report),
    24 * 60 * 60 * 1000,
  );
  interval.unref();
  return () => clearInterval(interval);
}

function closeLogStore(log: LogStore): void {
  log.close();
}

async function listenGatewayServer(
  log: LogStore,
  host: string,
  port: number,
  options: ServerOptions,
): Promise<Server> {
  try {
    const server = createGatewayServer(options);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    return server;
  } catch (error) {
    closeLogStore(log);
    throw error;
  }
}

function NOOP(): void {}

function checkBinding(host: string, token: string | undefined): void {
  if (!isLoopback(host) && (token === undefined || token.length < 16)) {
    throw new Error(`binding ${host} needs LOCAL_DECIDER_TOKEN (>= 16 chars) in the environment`);
  }
}

/**
 * Write the JSON Schemas next to config.yaml, then apply edits of it and of policy files as they
 * happen; an invalid edit is reported, not applied.
 */
function watchSettings(
  store: ConfigFile,
  control: EngineControl,
  log: (line: string) => void,
): () => void {
  writeSchemas(join(dirname(store.file), 'schemas'));
  const fail = (error: unknown): void =>
    log(`settings not applied: ${error instanceof Error ? error.message : String(error)}`);
  return store.watch({
    onConfig: () => {
      try {
        store.reload();
      } catch (error) {
        fail(error);
        return;
      }
      // Diff-based: a no-op after our own write, and it also catches an outside edit that a
      // settings-page save already folded into the file.
      control.applyConfig().then((notes) => {
        notes.forEach(log);
      }, fail);
    },
    onPolicies: () => {
      try {
        log(`reloaded policies: ${control.reloadPolicies().join(', ')}`);
      } catch (error) {
        fail(error);
      }
    },
  });
}
