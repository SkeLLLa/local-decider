import type { EngineConfig } from '../config.ts';
import type { Paths } from '../paths.ts';
import type { Toolchain } from '../toolchain.ts';
import { FastFlowLMEngine } from './fastflowlm.ts';
import { SystemOneRemoteEngine } from './remote.ts';
import { StrandsDeciderEngine } from './strands.ts';
import type { Engine } from './types.ts';

export function createEngine(config: EngineConfig, paths: Paths, tools?: Toolchain): Engine {
  if (config.type === 'systemone-remote') {
    return new SystemOneRemoteEngine(config);
  }
  if (config.type === 'fastflowlm') {
    return new FastFlowLMEngine(config, paths, tools);
  }
  return new StrandsDeciderEngine(config, paths, tools);
}

export { SystemOneRemoteEngine } from './remote.ts';
export { serveArgs, StrandsDeciderEngine, strandsBinary } from './strands.ts';
export { type Engine, type EngineHealth, type EngineState } from './types.ts';
