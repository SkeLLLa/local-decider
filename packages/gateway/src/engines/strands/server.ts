import { join } from 'node:path';

import type { StrandsEngineConfig } from '../../config.ts';
import type { Paths } from '../../paths.ts';
import type { Toolchain } from '../../toolchain.ts';
import type { HostInfo } from '../descriptor.ts';
import { SupervisedEngine, type ServerSpec } from '../supervised.ts';
import { resolveDevice } from './mlx.ts';

const STRANDS_VENV = 'strands-decider';

export function strandsBinary(paths: Paths): string {
  return join(paths.venvs, STRANDS_VENV, 'bin', 'strands-decider');
}

/** `serve` argv. Every element comes from validated config, never from a request. */
export function serveArgs(
  config: StrandsEngineConfig,
  port: number,
  host?: HostInfo,
  venv?: string,
): string[] {
  const args = ['serve', config.model, '--host', '127.0.0.1', '--port', String(port)];
  const device = resolveDevice(config.device, host, venv);
  if (device !== undefined) {
    args.push('--device', device);
  }
  args.push('--max-batch', String(config.maxBatch));
  // Warmup compiles kernel shapes; on CPU there is nothing to compile and it adds ~27 s to every
  // start (ready in 4.6 s without it, first request no slower). `--warmup` in extraArgs opts back in.
  if (device === 'cpu' && !config.extraArgs.some((a) => a === '--warmup' || a === '--no-warmup')) {
    args.push('--no-warmup');
  }
  args.push(...config.extraArgs);
  return args;
}

function strandsSpec(
  config: StrandsEngineConfig,
  paths: Paths,
  tools?: Toolchain,
  host?: HostInfo,
): ServerSpec {
  const binary = tools?.strandsDecider ?? strandsBinary(paths);
  return {
    id: 'strands-decider',
    model: config.model,
    url: config.url,
    startTimeoutSeconds: config.startTimeoutSeconds,
    healthPath: '/health',
    env: { PYTHONUNBUFFERED: '1', ...tools?.env },
    binary: () => ({
      path: binary,
      missing: `${binary} not found; run \`local-decider engine install\``,
    }),
    args: (port) => serveArgs(config, port, host, join(paths.venvs, STRANDS_VENV)),
    maxLength: (body) => (typeof body['max_length'] === 'number' ? body['max_length'] : undefined),
  };
}

/**
 * strands-decider: spawned from the managed venv (`local-decider engine install`) on a free
 * loopback port and supervised with restart backoff, or attached to `config.url`.
 */
export class StrandsDeciderEngine extends SupervisedEngine {
  constructor(config: StrandsEngineConfig, paths: Paths, tools?: Toolchain, host?: HostInfo) {
    super(strandsSpec(config, paths, tools, host), paths);
  }
}
