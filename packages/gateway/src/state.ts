/**
 * Before config.yaml held every setting, the settings pages wrote their choices to
 * `<data>/state.json`. This turns such a file into config edits, once; see `ConfigFile.open`.
 */
import { MODES } from '@local-decider/core';
import { readFileSync } from 'node:fs';

import type { ConfigEdit } from './config-file.ts';
import { isSelectableEngine } from './engines/registry.ts';

const PATH_KEYS = new Set([
  'tools.flm',
  'tools.strandsDecider',
  'tools.uv',
  'dirs.flmModels',
  'dirs.hfCache',
]);
const POLICY_ID = /^[a-z][a-z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectionEdits(sel: unknown): ConfigEdit[] {
  if (!isRecord(sel) || !isSelectableEngine(sel['engine']) || typeof sel['model'] !== 'string') {
    return [];
  }
  const device = typeof sel['device'] === 'string' ? { device: sel['device'] } : {};
  return [
    { path: ['selection'], value: { engine: sel['engine'], model: sel['model'], ...device } },
  ];
}

function lifecycleEdits(life: unknown): ConfigEdit[] {
  if (
    !isRecord(life) ||
    (life['lifecycle'] !== 'lazy' && life['lifecycle'] !== 'eager') ||
    typeof life['idleUnloadMinutes'] !== 'number'
  ) {
    return [];
  }
  return [
    { path: ['lifecycle', 'mode'], value: life['lifecycle'] },
    { path: ['lifecycle', 'idleUnloadMinutes'], value: life['idleUnloadMinutes'] },
  ];
}

function recordEdits(
  value: unknown,
  edit: (key: string, entry: unknown) => ConfigEdit | null,
): ConfigEdit[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const one = edit(key, entry);
    return one === null ? [] : [one];
  });
}

/** Edits that reproduce a `state.json`; unreadable or malformed parts are skipped. */
export function stateEdits(file: string): ConfigEdit[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!isRecord(raw)) {
    return [];
  }
  return [
    ...selectionEdits(raw['selection']),
    ...lifecycleEdits(raw['lifecycle']),
    ...recordEdits(raw['paths'], (key, value) =>
      PATH_KEYS.has(key) && typeof value === 'string' ? { path: key.split('.'), value } : null,
    ),
    ...recordEdits(raw['policyModes'], (id, mode) =>
      POLICY_ID.test(id) && (MODES as readonly unknown[]).includes(mode)
        ? { path: ['policies', id, 'mode'], value: mode }
        : null,
    ),
    ...recordEdits(raw['policyVariants'], (id, variant) =>
      POLICY_ID.test(id) && typeof variant === 'string' && POLICY_ID.test(variant)
        ? { path: ['policies', id, 'variant'], value: variant }
        : null,
    ),
  ];
}
