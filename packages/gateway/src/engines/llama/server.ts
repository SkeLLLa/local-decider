import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { Paths } from '../../paths.ts';
import type { Toolchain } from '../../toolchain.ts';
import { SupervisedEngine, type ServerSpec } from '../supervised.ts';
import { EngineError } from '../types.ts';
import type { LlamaVulkanEngineConfig } from './index.ts';
import { GGUF, ggufPath } from './models.ts';
import { recordMatches } from './verified.ts';

export const LLAMA_INSTALL_URL = 'https://github.com/ggml-org/llama.cpp/releases';
const LLAMA_MINIMUM_BUILD = 'b11572';

export function effectiveLlamaBinary(
  config: { readonly binary?: string | undefined },
  tools?: Toolchain,
): string | undefined {
  const binary = config.binary;
  if (binary === undefined) return tools?.llamaServer;
  if (!isAbsolute(binary)) return undefined;
  try {
    accessSync(binary, constants.X_OK);
    return statSync(binary).isFile() ? binary : undefined;
  } catch {
    return undefined;
  }
}

export function llamaServerArgs(
  config: LlamaVulkanEngineConfig,
  modelPath: string,
  port: number,
): string[] {
  const ctx = String(config.ctxSize);
  return [
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-m',
    modelPath,
    '-a',
    config.model,
    '-c',
    ctx,
    '-b',
    ctx,
    '-ub',
    ctx,
    '-ngl',
    String(config.gpuLayers),
    '-np',
    '1',
    '--no-webui',
    '--offline',
    ...(config.vulkanDevice === undefined ? [] : ['-dev', config.vulkanDevice]),
  ];
}

function llamaModelPath(config: LlamaVulkanEngineConfig, paths: Paths): string {
  const path = ggufPath(paths, config.model);
  if (path === undefined) throw new Error(`unknown llama-vulkan model: ${config.model}`);
  return path;
}

function binaryMissing(
  config: LlamaVulkanEngineConfig,
  modelPath: string,
  binary: string | undefined,
): string | undefined {
  if (config.binary !== undefined && binary === undefined) {
    return `engines.llama-vulkan.binary ${config.binary} is not an executable file`;
  }
  if (binary === undefined) {
    return `llama-server not found on PATH; install a Vulkan-enabled llama.cpp build or set tools.llamaServer (${LLAMA_INSTALL_URL})`;
  }
  if (!recordMatches(modelPath, GGUF[config.model]!.sha256)) {
    return `model ${config.model} not downloaded or not verified; run local-decider engine install --engine llama-vulkan`;
  }
  return undefined;
}

export function llamaSpec(
  config: LlamaVulkanEngineConfig,
  paths: Paths,
  tools?: Toolchain,
): ServerSpec {
  const path = llamaModelPath(config, paths);
  const binary = effectiveLlamaBinary(config, tools);
  return {
    id: 'llama-vulkan',
    model: config.model,
    url: config.url,
    startTimeoutSeconds: config.startTimeoutSeconds,
    healthPath: '/health',
    env: { ...tools?.env },
    binary: () => {
      const missing = binaryMissing(config, path, binary);
      if (missing !== undefined) return { missing };
      return binary === undefined
        ? { missing: 'llama-server is not available' }
        : { path: binary, missing: `${binary} not found` };
    },
    args: (port) => llamaServerArgs(config, path, port),
    maxLength: () => config.ctxSize,
  };
}

export class LlamaVulkanEngine extends SupervisedEngine {
  constructor(config: LlamaVulkanEngineConfig, paths: Paths, tools?: Toolchain) {
    super(llamaSpec(config, paths, tools), paths);
  }

  override async decide(
    request: SystemOneRequest,
    signal: AbortSignal,
  ): Promise<SystemOneResponse> {
    try {
      return await super.decide(request, signal);
    } catch (error) {
      if (error instanceof EngineError && missingSystemOneEndpoint(error)) {
        throw new EngineError(
          `llama-server too old: needs /v1/systemone and d3 support (llama.cpp ≥ ${LLAMA_MINIMUM_BUILD})`,
        );
      }
      throw error;
    }
  }
}

function missingSystemOneEndpoint(error: EngineError): boolean {
  const failure = error.httpFailure;
  if (
    failure?.status !== 404 ||
    !failure.path.endsWith('/v1/systemone') ||
    /\b(?:model|alias)\b/i.test(failure.body)
  ) {
    return false;
  }
  return /not found|cannot post/i.test(failure.body);
}

export function llamaEngineConfig(config: {
  readonly engine: {
    readonly type: string;
    readonly binary?: string | undefined;
    readonly url?: string | undefined;
  };
  readonly engines?:
    | {
        readonly 'llama-vulkan'?:
          | { readonly binary?: string | undefined; readonly url?: string | undefined }
          | undefined;
      }
    | undefined;
}): { readonly binary?: string | undefined; readonly url?: string | undefined } {
  if (config.engine.type === 'llama-vulkan') return config.engine;
  return config.engines?.['llama-vulkan'] ?? {};
}
