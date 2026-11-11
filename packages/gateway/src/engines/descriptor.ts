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

export interface EngineContext {
  readonly paths: Paths;
  /** Existing callers may omit resolved tool paths. */
  readonly tools?: Toolchain;
  readonly host: HostInfo;
  readonly env: NodeJS.ProcessEnv;
}

export type Support = { readonly ok: true } | { readonly ok: false; readonly reason: string };

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
  tag(config: C, host: HostInfo): string;
  devices?(host: HostInfo): readonly Device[];
  readonly calibrated: boolean;
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
  tag(config: z.output<S>, host: HostInfo): string;
  devices?(host: HostInfo): readonly Device[];
  readonly calibrated: boolean;
  create(config: z.output<S>, ctx: EngineContext): Engine;
}): EngineDescriptor<z.output<S>, S, Selectable> {
  return descriptor;
}
