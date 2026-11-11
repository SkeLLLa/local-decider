import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';

import { ConfigFile, MemoryConfigStore, type ConfigStore } from './config-file.ts';
import { isLoopback, type GatewayConfig } from './config.ts';
import { Decider } from './decider.ts';
import { EngineControl } from './engine-control.ts';
import type { Engine } from './engines/types.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs, type LoadedPolicy } from './policies.ts';
import { ensureReportToken } from './report-token.ts';
import { writeSchemas } from './schemas.ts';
import { createGatewayServer } from './server.ts';
import { ShadowLog } from './shadow.ts';

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
  const log = new ShadowLog(paths.logs);
  const reportToken = ensureReportToken(paths);
  pruneLogs(log, config.logs.retainDays, report);
  const decider = new Decider({
    engine,
    policies: options.policies ?? loadPolicies(config, policyDirs(config, paths)),
    log,
    decisionTimeoutMs: config.decisionTimeoutMs,
  });
  decider.rebuildPrecedent(log.readRecent(90));
  engineControl?.bind(decider);
  const server = createGatewayServer({
    decider,
    log,
    token: hasToken ? token : undefined,
    reportToken,
    engineControl,
    pricing: config.pricing,
    settings: () => engineControl?.settings ?? store.current,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  void engine.start();
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
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function pruneLogs(log: ShadowLog, retainDays: number, report: (line: string) => void): void {
  try {
    log.prune(retainDays);
  } catch (error) {
    report(`log retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scheduleLogPruning(
  log: ShadowLog,
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
