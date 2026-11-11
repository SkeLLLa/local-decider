// fallow-ignore-file duplicate-export -- Keep the existing paths/tools API beside the registry context API.
import type { Paths } from '../paths.ts';
import type { Toolchain } from '../toolchain.ts';
import { hostInfo } from './host.ts';
import { createEngine as createFromRegistry } from './registry.ts';
import type { EngineConfig } from './registry.ts';
import type { Engine } from './types.ts';

export function createEngine(config: EngineConfig, paths: Paths, tools?: Toolchain): Engine {
  return createFromRegistry(config, {
    paths,
    ...(tools === undefined ? {} : { tools }),
    host: hostInfo(),
    env: process.env,
  });
}

export { SystemOneRemoteEngine } from './remote.ts';
export { serveArgs, StrandsDeciderEngine, strandsBinary } from './strands/server.ts';
export { type Engine, type EngineHealth, type EngineState } from './types.ts';
