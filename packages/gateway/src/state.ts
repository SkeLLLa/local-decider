import { MODES, type Mode } from '@local-decider/core';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Paths } from './paths.ts';

/** Choices made at runtime (settings page) that outlive a restart; config.yaml stays the default. */
export interface GatewayState {
  readonly selection?: {
    readonly engine: string;
    readonly model: string;
    readonly device?: string;
  };
  /** Path overrides by key (`tools.flm`, `dirs.hfCache`, ...). */
  readonly paths?: Readonly<Record<string, string>>;
  readonly lifecycle?: { readonly lifecycle: string; readonly idleUnloadMinutes: number };
  /** Per-policy run mode set from the settings page; beats config.yaml and the policy file. */
  readonly policyModes?: Readonly<Record<string, Mode>>;
}

function stateFile(paths: Paths): string {
  return join(paths.data, 'state.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseState(raw: unknown): GatewayState {
  if (!isRecord(raw)) {
    return {};
  }
  const out: {
    selection?: NonNullable<GatewayState['selection']>;
    paths?: Record<string, string>;
    lifecycle?: NonNullable<GatewayState['lifecycle']>;
    policyModes?: Record<string, Mode>;
  } = {};
  if (isRecord(raw['policyModes'])) {
    out.policyModes = Object.fromEntries(
      Object.entries(raw['policyModes']).filter(
        (e): e is [string, Mode] =>
          typeof e[1] === 'string' && (MODES as readonly string[]).includes(e[1]),
      ),
    );
  }
  const life = raw['lifecycle'];
  if (
    isRecord(life) &&
    (life['lifecycle'] === 'lazy' || life['lifecycle'] === 'eager') &&
    typeof life['idleUnloadMinutes'] === 'number'
  ) {
    out.lifecycle = { lifecycle: life['lifecycle'], idleUnloadMinutes: life['idleUnloadMinutes'] };
  }
  const sel = raw['selection'];
  if (isRecord(sel) && typeof sel['engine'] === 'string' && typeof sel['model'] === 'string') {
    out.selection = {
      engine: sel['engine'],
      model: sel['model'],
      ...(typeof sel['device'] === 'string' ? { device: sel['device'] } : {}),
    };
  }
  if (isRecord(raw['paths'])) {
    out.paths = Object.fromEntries(
      Object.entries(raw['paths']).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }
  return out;
}

/** Unreadable or malformed state is ignored: the gateway falls back to config.yaml. */
export function loadState(paths: Paths): GatewayState {
  const file = stateFile(paths);
  if (!existsSync(file)) {
    return {};
  }
  try {
    return parseState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

/** Atomic write (temp file + rename), user-only permissions. */
export function saveState(paths: Paths, state: GatewayState): void {
  const file = stateFile(paths);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
