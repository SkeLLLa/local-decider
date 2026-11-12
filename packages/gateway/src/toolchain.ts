import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';

import type { GatewayConfig } from './config.ts';
import type { HostInfo } from './engines/descriptor.ts';
import { FLM_INSTALL_URL } from './engines/fastflowlm/status.ts';
import { hostInfo } from './engines/host.ts';
import { engineDescriptor, type EngineId } from './engines/registry.ts';
import { strandsBinary } from './engines/strands/server.ts';
import type { Paths } from './paths.ts';

export { probe, stripAnsi } from './toolchain-probe.ts';

export const PATH_KEYS = [
  'tools.flm',
  'tools.strandsDecider',
  'tools.uv',
  'dirs.flmModels',
  'dirs.hfCache',
] as const;
export type PathKey = (typeof PATH_KEYS)[number];

export type PathSource = 'config' | 'managed' | 'path' | 'default' | 'missing';

export interface PathEntry {
  readonly key: PathKey;
  readonly label: string;
  readonly kind: 'executable' | 'directory';
  /** The user's override from the settings page; null = automatic discovery. */
  readonly value: string | null;
  readonly effective: string | null;
  readonly source: PathSource;
  readonly ok: boolean;
  readonly detail: string | null;
  /** Where to install or read about this tool or directory; a fixed https URL, absent if none. */
  readonly installUrl?: string;
}

interface PathDef {
  /** Fixed https constant, never derived from input. */
  readonly installUrl?: string;
  readonly label: string;
  readonly kind: 'executable' | 'directory';
  readonly engine?: EngineId;
  /** Required basename for executables, so a path can only ever name that tool. */
  readonly tool?: string;
  /** Automatic candidates in order: [source, path]. */
  readonly auto: (
    paths: Paths,
    env: NodeJS.ProcessEnv,
  ) => readonly [PathSource, string | undefined][];
}

/** Where to read how to install strands-decider; a fixed https constant. */
export const STRANDS_INSTALL_URL =
  'https://github.com/ziptie-soft/local-decider/blob/master/docs/install.md#2-engine';

export function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir !== '' && isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function hfDefault(env: NodeJS.ProcessEnv): string {
  if (env['HF_HUB_CACHE'] !== undefined) {
    return env['HF_HUB_CACHE'];
  }
  return join(env['HF_HOME'] ?? join(homedir(), '.cache', 'huggingface'), 'hub');
}

const DEFS: Readonly<Record<PathKey, PathDef>> = {
  'tools.flm': {
    label: 'FastFlowLM launcher (flm)',
    kind: 'executable',
    engine: 'fastflowlm',
    tool: 'flm',
    installUrl: FLM_INSTALL_URL,
    // Installed by the user (dnf, apt or the upstream installer); the gateway never downloads it.
    auto: (_paths, env) => [['path', onPath('flm', env)]],
  },
  'tools.strandsDecider': {
    label: 'strands-decider',
    kind: 'executable',
    tool: 'strands-decider',
    installUrl: STRANDS_INSTALL_URL,
    // A system-wide install wins over the venv `local-decider engine install` prepares.
    auto: (paths, env) => [
      ['path', onPath('strands-decider', env)],
      ['managed', strandsBinary(paths)],
    ],
  },
  'tools.uv': {
    label: 'uv (installs the Python engine)',
    kind: 'executable',
    tool: 'uv',
    installUrl: 'https://docs.astral.sh/uv/getting-started/installation/',
    auto: (_paths, env) => [['path', onPath('uv', env)]],
  },
  'dirs.flmModels': {
    label: 'FastFlowLM models',
    kind: 'directory',
    installUrl: 'https://github.com/FastFlowLM/FastFlowLM',
    engine: 'fastflowlm',
    auto: (_paths, env) => [
      ['default', env['FLM_MODEL_PATH'] ?? join(homedir(), '.config', 'flm', 'models')],
    ],
  },
  'dirs.hfCache': {
    label: 'Hugging Face cache',
    kind: 'directory',
    installUrl: 'https://huggingface.co/docs/huggingface_hub/guides/manage-cache',
    auto: (_paths, env) => [['default', hfDefault(env)]],
  },
};

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Why a user-supplied path is unacceptable for `key`, or undefined when it is fine. */
export function checkPath(key: PathKey, value: string): string | undefined {
  const def = DEFS[key];
  if (!isAbsolute(value)) {
    return 'use an absolute path';
  }
  if (def.kind === 'directory') {
    return existsSync(value) && statSync(value).isDirectory()
      ? undefined
      : `${value} is not a directory`;
  }
  if (def.tool !== undefined && basename(value) !== def.tool) {
    return `expected a file named ${def.tool}`;
  }
  return isExecutable(value) ? undefined : `${value} is not an executable file`;
}

function configValue(config: GatewayConfig, key: PathKey): string | undefined {
  const [group, name] = key.split('.') as ['tools' | 'dirs', string];
  return (config[group] as Record<string, string | undefined>)[name];
}

function present(def: PathDef, path: string): boolean {
  return def.kind === 'directory' ? true : isExecutable(path);
}

/** One entry: config.yaml (where the settings pages write too), else automatic discovery. */
export function resolveEntry(
  key: PathKey,
  config: GatewayConfig,
  paths: Paths,
  env: NodeJS.ProcessEnv = process.env,
): PathEntry {
  const def = DEFS[key];
  const value = configValue(config, key) ?? null;
  const base = {
    key,
    label: def.label,
    kind: def.kind,
    value,
    ...(def.installUrl === undefined ? {} : { installUrl: def.installUrl }),
  };
  const chosen: [PathSource, string | undefined] =
    value !== null
      ? ['config', value]
      : (def.auto(paths, env).find(([, p]) => p !== undefined && present(def, p)) ?? [
          'missing',
          undefined,
        ]);
  const [source, effective] = chosen;
  if (effective === undefined) {
    return {
      ...base,
      effective: null,
      source: 'missing',
      ok: false,
      detail: `${def.label} not found`,
    };
  }
  const problem = source === 'default' ? undefined : checkPath(key, effective);
  return { ...base, effective, source, ok: problem === undefined, detail: problem ?? null };
}

export function resolveAll(
  config: GatewayConfig,
  paths: Paths,
  env?: NodeJS.ProcessEnv,
  host: HostInfo = hostInfo(),
): PathEntry[] {
  return PATH_KEYS.filter((key) => {
    const engine = DEFS[key].engine;
    return engine === undefined || engineDescriptor(engine)?.supports(host).ok !== false;
  }).map((key) => resolveEntry(key, config, paths, env));
}

/** Resolved locations the engines and downloads use. */
export interface Toolchain {
  readonly flm: string | undefined;
  readonly strandsDecider: string | undefined;
  readonly uv: string | undefined;
  /** Extra environment for every engine and download child process. */
  readonly env: Readonly<Record<string, string>>;
}

export function toolchain(config: GatewayConfig, paths: Paths, env?: NodeJS.ProcessEnv): Toolchain {
  const get = (key: PathKey): string | undefined => {
    const entry = resolveEntry(key, config, paths, env);
    return entry.ok && entry.effective !== null ? entry.effective : undefined;
  };
  const flmModels = resolveEntry('dirs.flmModels', config, paths, env);
  const hfCache = resolveEntry('dirs.hfCache', config, paths, env);
  return {
    flm: get('tools.flm'),
    strandsDecider: get('tools.strandsDecider'),
    uv: get('tools.uv'),
    env: {
      ...(flmModels.source === 'default' || flmModels.effective === null
        ? {}
        : { FLM_MODEL_PATH: flmModels.effective }),
      ...(hfCache.source === 'default' || hfCache.effective === null
        ? {}
        : { HF_HUB_CACHE: hfCache.effective }),
    },
  };
}
