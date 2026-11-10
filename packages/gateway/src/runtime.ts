import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { isLoopback, type GatewayConfig } from './config.ts';
import { Decider } from './decider.ts';
import { EngineControl } from './engine-control.ts';
import type { Engine } from './engines/types.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, type LoadedPolicy } from './policies.ts';
import { createGatewayServer } from './server.ts';
import { ShadowLog } from './shadow.ts';

export interface Gateway {
  readonly server: Server;
  readonly decider: Decider;
  readonly url: string;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly config: GatewayConfig;
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
  const token = env['LOCAL_DECIDER_TOKEN'];
  if (!isLoopback(config.host) && (token === undefined || token.length < 16)) {
    throw new Error(
      `binding ${config.host} needs LOCAL_DECIDER_TOKEN (>= 16 chars) in the environment`,
    );
  }
  const hasToken = token !== undefined && token !== '';
  // An injected engine (tests) is not rebuilt from config, so it cannot be switched.
  const engineControl =
    options.engineControl ??
    (options.engine === undefined
      ? new EngineControl({ config, paths, env, pathsEditable: !hasToken })
      : undefined);
  const engine = options.engine ?? (engineControl as EngineControl).engine;
  const log = new ShadowLog(paths.logs);
  const decider = new Decider({
    engine,
    policies: options.policies ?? loadPolicies(config),
    log,
    decisionTimeoutMs: config.decisionTimeoutMs,
  });
  engineControl?.bind(decider);
  const server = createGatewayServer({
    decider,
    log,
    token: hasToken ? token : undefined,
    engineControl,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  void engine.start();
  const { port } = server.address() as AddressInfo;
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return {
    server,
    decider,
    url: `http://${host}:${String(port)}`,
    async close() {
      await engineControl?.idle();
      await decider.engine.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
