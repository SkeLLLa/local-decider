import { parseArgs } from 'node:util';

import { defaultFlavor, type InstallFlavor } from './engine-install.ts';
import type { HostInfo } from './engines/descriptor.ts';
import { engineDescriptor } from './engines/registry.ts';

const FLAVORS: readonly InstallFlavor[] = ['cpu', 'mlx', 'cuda'];
const FLM_HOST_REFUSAL =
  'fastflowlm runs on Linux x86_64 with an AMD XDNA2 NPU; on macOS use strands-decider (MLX) or openai-compatible';

export class EngineInstallUsageError extends Error {
  override readonly name = 'EngineInstallUsageError';
  readonly exitCode = 2;
}

export type InstallPlan =
  | { readonly engine: 'strands-decider'; readonly flavor: InstallFlavor; readonly model?: string }
  | {
      readonly engine: 'fastflowlm';
      readonly model?: string;
      readonly noDownload: boolean;
    };

function refusal(engine: string): never {
  if (engine === 'openai-compatible') {
    throw new EngineInstallUsageError(
      'nothing to install for openai-compatible: start your server and set engines.openai-compatible.url',
    );
  }
  throw new EngineInstallUsageError(`nothing to install for ${engine}`);
}

interface InstallArgs {
  readonly 'engine'?: string;
  readonly 'flavor'?: string;
  readonly 'model'?: string;
  readonly 'no-download'?: boolean;
}

function parseInstallArgs(argv: readonly string[]): InstallArgs {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        'engine': { type: 'string' },
        'flavor': { type: 'string' },
        'model': { type: 'string' },
        'no-download': { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    throw new EngineInstallUsageError(error instanceof Error ? error.message : String(error));
  }
}

function supportedTarget(engine: string, host: HostInfo): 'strands-decider' | 'fastflowlm' {
  if (engine !== 'strands-decider' && engine !== 'fastflowlm') {
    return refusal(engine);
  }
  const descriptor = engineDescriptor(engine);
  if (descriptor === undefined) {
    return refusal(engine);
  }
  const support = descriptor.supports(host);
  if (engine === 'fastflowlm' && (!support.ok || host.arch !== 'x64')) {
    throw new EngineInstallUsageError(FLM_HOST_REFUSAL);
  }
  if (!support.ok) {
    throw new EngineInstallUsageError(`${engine} is not supported: ${support.reason}`);
  }
  return engine;
}

function strandsPlan(values: InstallArgs, host: HostInfo, model: string | undefined): InstallPlan {
  if (values.flavor !== undefined && !FLAVORS.includes(values.flavor as InstallFlavor)) {
    throw new EngineInstallUsageError(`invalid strands-decider flavor "${values.flavor}"`);
  }
  const flavor =
    (values.flavor as InstallFlavor | undefined) ?? defaultFlavor(host.platform, host.arch);
  return {
    engine: 'strands-decider',
    flavor,
    ...(values['no-download'] === true || model === undefined ? {} : { model }),
  };
}

function fastFlowPlan(values: InstallArgs, model: string | undefined): InstallPlan {
  if (values.flavor !== undefined) {
    throw new EngineInstallUsageError('--flavor is only valid for strands-decider');
  }

  return {
    engine: 'fastflowlm',
    ...(model === undefined ? {} : { model }),
    noDownload: values['no-download'] === true,
  };
}

/** Parse an install request and reject unsupported targets before installer I/O starts. */
export function planInstall(
  argv: readonly string[],
  host: HostInfo,
  configuredEngine: string,
  configuredModel?: string,
): InstallPlan {
  const values = parseInstallArgs(argv);
  const engine = supportedTarget(values.engine ?? configuredEngine, host);
  const model = values.model ?? (engine === configuredEngine ? configuredModel : undefined);
  return engine === 'fastflowlm' ? fastFlowPlan(values, model) : strandsPlan(values, host, model);
}
