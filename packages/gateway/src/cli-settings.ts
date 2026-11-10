/**
 * `local-decider config|routing|policies use|mode`: settings commands. They edit config.yaml
 * directly, so they work while the gateway is down; a running gateway applies the edit itself.
 */
import { HARNESSES, MODES } from '@local-decider/core';
import { join } from 'node:path';

import { ConfigFile, type ConfigEdit } from './config-file.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs } from './policies.ts';
import { writeSchemas } from './schemas.ts';

export class SettingsUsageError extends Error {}

function edit(paths: Paths, edits: readonly ConfigEdit[]): ConfigFile {
  const store = ConfigFile.open(paths);
  store.update(edits);
  return store;
}

function harnessOf(value: string | undefined): string {
  if (value === undefined || !(HARNESSES as readonly string[]).includes(value)) {
    throw new SettingsUsageError(`harness must be one of ${HARNESSES.join(', ')}`);
  }
  return value;
}

/** `config path|schema|check`. */
export function configCommand(paths: Paths, args: readonly string[]): string {
  const [sub, dir] = args;
  if (sub === 'path' || sub === undefined) {
    const store = ConfigFile.open(paths);
    return [
      `config:  ${store.file}`,
      `schemas: ${join(paths.config, 'schemas')}`,
      `policies: ${join(paths.config, 'policies')}`,
    ].join('\n');
  }
  if (sub === 'schema') {
    return Object.values(writeSchemas(dir ?? join(paths.config, 'schemas'))).join('\n');
  }
  if (sub === 'check') {
    const store = ConfigFile.open(paths);
    loadPolicies(store.current, policyDirs(store.current, paths));
    return `${store.file}: ok`;
  }
  throw new SettingsUsageError();
}

/** `routing [map <harness> <preset> <model> [mode] | unmap <harness> <preset>]`. */
export function routingCommand(paths: Paths, args: readonly string[]): string {
  const [sub, harness, preset, model, mode] = args;
  if (sub === undefined) {
    const store = ConfigFile.open(paths);
    return JSON.stringify(store.current.routing.presets, null, 2);
  }
  if (sub === 'map' && preset !== undefined && model !== undefined) {
    const value = { model, ...(mode === undefined ? {} : { mode }) };
    edit(paths, [{ path: ['routing', 'presets', harnessOf(harness), preset], value }]);
    return `route:${preset} → ${model} for ${String(harness)}`;
  }
  if (sub === 'unmap' && preset !== undefined) {
    edit(paths, [{ path: ['routing', 'presets', harnessOf(harness), preset], value: undefined }]);
    return `route:${preset} unmapped for ${String(harness)}`;
  }
  throw new SettingsUsageError();
}

/** `policies use <policy> <variant>`: checked against the policy files before writing. */
export function useVariant(paths: Paths, id: string, variant: string): string {
  const store = ConfigFile.open(paths);
  const policies = loadPolicies(store.current, policyDirs(store.current, paths));
  const base = policies.get(id);
  if (base === undefined || base.policy.variantOf !== undefined) {
    throw new Error(`no policy "${id}" to choose a variant for`);
  }
  if (variant !== id && policies.get(variant)?.policy.variantOf !== id) {
    const variants = [...policies.values()]
      .filter(({ policy }) => policy.variantOf === id)
      .map(({ policy }) => policy.id);
    throw new Error(
      `"${variant}" is not a variant of ${id}; choose ${[id, ...variants].join(', ')}`,
    );
  }
  store.update([
    { path: ['policies', id, 'variant'], value: variant === id ? undefined : variant },
  ]);
  return `${id} → ${variant}`;
}

/** `policies mode <policy> off|shadow|act`. */
export function setMode(paths: Paths, id: string, mode: string): string {
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new SettingsUsageError(`mode must be one of ${MODES.join(', ')}`);
  }
  edit(paths, [{ path: ['policies', id, 'mode'], value: mode }]);
  return `${id}: ${mode}`;
}
