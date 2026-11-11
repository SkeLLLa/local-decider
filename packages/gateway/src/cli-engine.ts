import { parseArgs } from 'node:util';

import { isOpenAILike } from './engine-discovery.ts';
import { defaultFlavor, type InstallFlavor } from './engine-install.ts';
import type { HostInfo } from './engines/descriptor.ts';
import { engineDescriptor } from './engines/registry.ts';

const FLAVORS: readonly InstallFlavor[] = ['cpu', 'mlx', 'cuda'];
const FLM_HOST_REFUSAL =
  'fastflowlm runs on Linux x86_64 with an AMD XDNA2 NPU; on macOS use strands-decider (MLX) or openai-compatible';

export class EngineInstallUsageError extends Error {
  override readonly name = 'EngineInstallUsageError';
  // fallow-ignore-next-line unused-class-member -- cli.ts uses this to set the process exit status.
  readonly exitCode = 2;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function displayText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function engineLine(engine: UnknownRecord, activeId: string | undefined): string | undefined {
  const id = displayText(engine['id']);
  if (id === '') {
    return undefined;
  }
  const supported =
    typeof engine['supported'] === 'boolean'
      ? `supported: ${engine['supported'] ? 'yes' : 'no'}`
      : 'supported: unknown';
  const reason = engine['supported'] === false ? displayText(engine['unsupportedReason']) : '';
  const label = displayText(engine['label'], id);
  const detail = displayText(engine['detail']);
  const description = detail === '' ? label : `${label} — ${detail}`;
  return [
    id,
    supported,
    ...(activeId === id ? ['active'] : []),
    ...(reason === '' ? [] : [reason]),
    description,
  ].join(' | ');
}

function modelLines(models: readonly unknown[], engineId: string): string[] {
  return models.flatMap((model) => {
    const row = asRecord(model);
    if (row === undefined || row['engine'] !== engineId || typeof row['id'] !== 'string') {
      return [];
    }
    const installed =
      typeof row['installed'] === 'boolean'
        ? ` (${row['installed'] ? 'installed' : 'not installed'})`
        : '';
    return [`  ${row['id']}${installed}`];
  });
}

/** Lenient plain-text view of a gateway engine catalog. */
export function formatEngineList(payload: unknown): string {
  const root = asRecord(payload);
  if (root === undefined || !Array.isArray(root['engines'])) {
    return 'gateway returned an invalid engine list';
  }
  const active = asRecord(root['active']);
  const activeId = typeof active?.['engine'] === 'string' ? active['engine'] : undefined;
  const models = Array.isArray(root['models']) ? root['models'] : [];
  const lines = root['engines'].flatMap((item) => {
    const engine = asRecord(item);
    if (engine === undefined) {
      return [];
    }
    const line = engineLine(engine, activeId);
    return line === undefined ? [] : [line, ...modelLines(models, String(engine['id']))];
  });
  return lines.length === 0 ? 'no engines available' : lines.join('\n');
}

export type InstallPlan =
  | { readonly engine: 'strands-decider'; readonly flavor: InstallFlavor; readonly model?: string }
  | {
      readonly engine: 'fastflowlm';
      readonly model?: string;
      readonly noDownload: boolean;
    };

function refusal(engine: string): never {
  if (engine === 'lmstudio') {
    throw new EngineInstallUsageError(
      'nothing to install for lmstudio: get LM Studio from https://lmstudio.ai/download, start its server (lms server start) and load a model',
    );
  }
  if (isOpenAILike(engine)) {
    throw new EngineInstallUsageError(
      `nothing to install for ${engine}: start your server and set engines.${engine}.url`,
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
