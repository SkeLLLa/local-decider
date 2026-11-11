import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { FlmEngineConfig } from '../../config.ts';
import type { Paths } from '../../paths.ts';
import type { Toolchain } from '../../toolchain.ts';
import { SupervisedEngine, type ServerSpec } from '../supervised.ts';

export const FLM_DIR = 'fastflowlm';

function versionKey(v: string): number[] {
  return v.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function newestFirst(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

/** The managed `flm` launcher: the newest `engines/fastflowlm/<version>/dist/flm`. */
export function managedFlm(paths: Paths): string | undefined {
  const root = join(paths.engines, FLM_DIR);
  if (!existsSync(root)) {
    return undefined;
  }
  const versions = readdirSync(root)
    .filter((v) => /^\d+(\.\d+)*$/.test(v))
    .toSorted(newestFirst);
  return versions.map((v) => join(root, v, 'dist', 'flm')).find((path) => existsSync(path));
}

/** `flm serve` argv for a decision model only. Every element comes from validated config. */
export function flmServeArgs(config: FlmEngineConfig, port: number): string[] {
  return [
    'serve',
    '--decision',
    config.model,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--pmode',
    config.pmode,
  ];
}

function flmSpec(config: FlmEngineConfig, paths: Paths, tools?: Toolchain): ServerSpec {
  const path = config.binary ?? tools?.flm ?? managedFlm(paths);
  return {
    env: { ...tools?.env },
    id: 'fastflowlm',
    model: config.model,
    url: config.url,
    startTimeoutSeconds: config.startTimeoutSeconds,
    // FLM has no /health; the decision-model list answers once the model is loaded.
    healthPath: '/v1/systemone/models',
    binary: () =>
      path === undefined
        ? {
            missing:
              'FastFlowLM not installed; run `local-decider engine install --engine fastflowlm`',
          }
        : { path, missing: `${path} not found` },
    args: (port) => flmServeArgs(config, port),
    maxLength: (body) => {
      const data = body['data'];
      const first: unknown = Array.isArray(data) ? data[0] : undefined;
      const max =
        typeof first === 'object' && first !== null
          ? (first as Record<string, unknown>)['max_input_tokens']
          : undefined;
      return typeof max === 'number' ? max : undefined;
    },
  };
}

/** FastFlowLM (`flm serve --decision <d3 model>`) on the AMD XDNA NPU. */
export class FastFlowLMEngine extends SupervisedEngine {
  constructor(config: FlmEngineConfig, paths: Paths, tools?: Toolchain) {
    super(flmSpec(config, paths, tools), paths);
  }
}
