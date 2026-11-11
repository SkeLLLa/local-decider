import { join } from 'node:path';

import type { StrandsEngineConfig } from '../../config.ts';
import type { Paths } from '../../paths.ts';
import type { Toolchain } from '../../toolchain.ts';
import type { Device, HostInfo } from '../descriptor.ts';
import { SupervisedEngine, type ServerSpec } from '../supervised.ts';
import { resolveStrandsDevice, type DeviceResolution } from './mlx.ts';

const STRANDS_VENV = 'strands-decider';

export function strandsBinary(paths: Paths): string {
  return join(paths.venvs, STRANDS_VENV, 'bin', 'strands-decider');
}

/** `serve` argv. Every element comes from validated config, never from a request. */
export function serveArgs(
  config: StrandsEngineConfig,
  port: number,
  /** The device resolved for this launch; an explicit config device when omitted. */
  device: Exclude<Device, 'auto'> | undefined = config.device === 'auto'
    ? undefined
    : config.device,
): string[] {
  const args = ['serve', config.model, '--host', '127.0.0.1', '--port', String(port)];
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
  // Resolved once per launch (refreshed in `binary()`), so argv and health agree.
  let device: DeviceResolution = resolveStrandsDevice(config.device, host, binary);
  return {
    id: 'strands-decider',
    model: config.model,
    url: config.url,
    startTimeoutSeconds: config.startTimeoutSeconds,
    healthPath: '/health',
    env: { PYTHONUNBUFFERED: '1', ...tools?.env },
    binary: () => {
      device = resolveStrandsDevice(config.device, host, binary);
      return {
        path: binary,
        missing: `${binary} not found; run \`local-decider engine install\``,
      };
    },
    args: (port) => serveArgs(config, port, device.resolved),
    deviceInfo: () => device,
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
