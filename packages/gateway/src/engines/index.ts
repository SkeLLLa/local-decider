import type { EngineConfig } from '../config.ts';
import type { Paths } from '../paths.ts';
import { SystemOneRemoteEngine } from './remote.ts';
import { StrandsDeciderEngine } from './strands.ts';
import type { Engine } from './types.ts';

export function createEngine(config: EngineConfig, paths: Paths): Engine {
  if (config.type === 'systemone-remote') {
    return new SystemOneRemoteEngine(config);
  }
  return new StrandsDeciderEngine(config, paths);
}

export { SystemOneRemoteEngine } from './remote.ts';
export { serveArgs, StrandsDeciderEngine, strandsBinary } from './strands.ts';
export { EngineError, type Engine, type EngineHealth, type EngineState } from './types.ts';
