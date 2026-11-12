import type { z } from 'zod';

import type { Paths } from '../paths.ts';
import type { Toolchain } from '../toolchain.ts';
import type { Engine } from './types.ts';

export const DEVICES = ['auto', 'cpu', 'mlx', 'mps', 'cuda'] as const;
export type Device = (typeof DEVICES)[number];

export interface HostInfo {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly totalMemoryBytes: number;
}

/** Optional locations a tag may inspect (cheap file checks only). */
export type TagContext = Partial<Pick<EngineContext, 'paths' | 'tools'>>;

export interface EngineContext {
  readonly paths: Paths;
  /** Existing callers may omit resolved tool paths. */
  readonly tools?: Toolchain;
  readonly host: HostInfo;
  readonly env: NodeJS.ProcessEnv;
}

export interface Validation {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly summary: string;
  readonly lines: readonly string[];
}

export interface DownloadStep {
  readonly command: string;
  readonly args: readonly string[];
}

export interface EngineValidation {
  readonly label: string;
  readonly hint: string;
  readonly onStart: boolean;
  run(this: void, ctx: EngineContext): Promise<Validation>;
}

export type Support = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ModelDescriptor<E extends string = string> {
  readonly id: string;
  readonly engine: E;
  readonly label: string;
  readonly downloadGb: number | null;
  readonly memoryGb: number | null;
  readonly gpuMemoryGb?: number;
  readonly latencyHint: string | null;
  readonly recommended?: boolean;
  readonly quality?: {
    readonly jevBench?: number;
    readonly brier?: number;
    readonly decisionIndex?: number;
  };
  readonly source?: string;
  /** Engine-interpreted artifacts to download; strands uses Hugging Face repos, adapter first. */
  readonly artifacts?: readonly string[];
  /** Verified upstream base checkpoint; absent models have their own singleton family. */
  readonly baseModel?: string;
  /** Weight format short code used for display and quant selection. */
  readonly quant?: string;
}

export interface EngineDescriptor<
  C extends { readonly type: string; readonly model: string },
  S = z.ZodType<C>,
  Selectable extends boolean = boolean,
> {
  readonly id: C['type'];
  readonly label: string;
  readonly description: string;
  readonly configSchema: S;
  readonly selectable: Selectable;
  pinned?(config: C): boolean;
  supports(host: HostInfo): Support;
  tag(config: C, host: HostInfo, ctx?: TagContext): string;
  devices?(host: HostInfo): readonly Device[];
  readonly calibrated: boolean;
  readonly models: readonly ModelDescriptor<C['type']>[];
  /** Absent means all catalogue models are present. */
  modelsPresent?(
    this: void,
    models: readonly ModelDescriptor<C['type']>[],
    ctx: EngineContext,
  ): Promise<ReadonlyMap<string, boolean>>;
  /** Absent means this engine has no model download action. */
  downloadSteps?(
    this: void,
    model: ModelDescriptor<C['type']>,
    ctx: EngineContext,
  ): readonly DownloadStep[];
  readonly validation?: EngineValidation;
  create(config: C, ctx: EngineContext): Engine;
}

export function defineEngine<
  S extends z.ZodType<{ readonly type: string; readonly model: string }>,
  Selectable extends boolean,
>(descriptor: {
  readonly id: z.output<S>['type'];
  readonly label: string;
  readonly description: string;
  readonly configSchema: S;
  readonly selectable: Selectable;
  pinned?(config: z.output<S>): boolean;
  supports(host: HostInfo): Support;
  tag(config: z.output<S>, host: HostInfo, ctx?: TagContext): string;
  devices?(host: HostInfo): readonly Device[];
  readonly calibrated: boolean;
  readonly models: readonly ModelDescriptor<z.output<S>['type']>[];
  modelsPresent?(
    this: void,
    models: readonly ModelDescriptor<z.output<S>['type']>[],
    ctx: EngineContext,
  ): Promise<ReadonlyMap<string, boolean>>;
  downloadSteps?(
    this: void,
    model: ModelDescriptor<z.output<S>['type']>,
    ctx: EngineContext,
  ): readonly DownloadStep[];
  readonly validation?: EngineValidation;
  create(config: z.output<S>, ctx: EngineContext): Engine;
}): EngineDescriptor<z.output<S>, S, Selectable> {
  return descriptor;
}
