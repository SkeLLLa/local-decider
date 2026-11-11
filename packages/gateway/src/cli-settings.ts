/**
 * `local-decider config|routing|policies use|mode`: settings commands. They edit config.yaml
 * directly, so they work while the gateway is down; a running gateway applies the edit itself.
 */
import { HARNESSES, MODES, SCOPES } from '@ziptie-soft/local-decider-core';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { ConfigFile, type ConfigEdit } from './config-file.ts';
import { engineConnectionConfigPath, parseEngineConnection } from './engine-connection.ts';
import type { Paths } from './paths.ts';
import { loadPolicies, policyDirs } from './policies.ts';
import { writeSchemas } from './schemas.ts';

export class SettingsUsageError extends Error {}

function edit(paths: Paths, edits: readonly ConfigEdit[]): ConfigFile {
  const store = ConfigFile.open(paths);
  store.update(edits);
  return store;
}

/** `engine configure <engine> --url <url> --model <model> [--token-env <NAME>]`. */
export function configureEngine(paths: Paths, args: readonly string[]): string {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        'url': { type: 'string' },
        'model': { type: 'string' },
        'token-env': { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new SettingsUsageError(error instanceof Error ? error.message : String(error));
  }
  const [engine, ...extra] = parsed.positionals;
  const { url, model } = parsed.values;
  if (engine === undefined || extra.length > 0 || url === undefined || model === undefined) {
    throw new SettingsUsageError(
      'usage: local-decider engine configure <openai-compatible|lmstudio> --url <url> --model <model> [--token-env <NAME>]',
    );
  }
  let connection;
  try {
    connection = parseEngineConnection({
      engine,
      url,
      model,
      ...(parsed.values['token-env'] === undefined ? {} : { tokenEnv: parsed.values['token-env'] }),
    });
  } catch (error) {
    throw new SettingsUsageError(error instanceof Error ? error.message : String(error));
  }
  const store = ConfigFile.open(paths);
  const base = engineConnectionConfigPath(connection.engine, store.current.engine.type);
  store.update([
    { path: [...base, 'url'], value: connection.url },
    { path: [...base, 'model'], value: connection.model },
    { path: [...base, 'tokenEnv'], value: connection.tokenEnv },
  ]);
  return `configured ${connection.engine} at ${connection.url} for ${connection.model}; run local-decider engine use ${connection.engine} ${connection.model} to activate`;
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

type Target = { model?: string; mode?: string; thinking?: string; profile?: string };

const MAP_OPTIONS = {
  thinking: { type: 'string' },
  mode: { type: 'string' },
  profile: { type: 'string' },
} as const;

/** Fields only Paseo can apply (it starts the agent); other harnesses only get a hint. */
const PASEO_ONLY = {
  mode: 'a hook cannot switch the session mode',
  profile: 'it names a Paseo agent profile',
} as const;

function parseMapArgs(args: readonly string[]): {
  positionals: string[];
  values: Partial<Record<keyof typeof MAP_OPTIONS, string>>;
} {
  try {
    return parseArgs({
      args: [...args],
      options: MAP_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    throw new SettingsUsageError(error instanceof Error ? error.message : String(error));
  }
}

/** `<harness> <preset> [model] [mode] [--thinking l] [--mode m] [--profile id]` → a target. */
function mapTarget(args: readonly string[]): { harness: string; preset: string; target: Target } {
  const { positionals, values } = parseMapArgs(args);
  const [harnessArg, preset, model, positionalMode, ...extra] = positionals;
  if (preset === undefined || extra.length > 0) throw new SettingsUsageError();
  const harness = harnessOf(harnessArg);
  if (positionalMode !== undefined && values.mode !== undefined) {
    throw new SettingsUsageError('give the mode either positionally or with --mode, not both');
  }
  const target = definedFields({ model, ...values, mode: values.mode ?? positionalMode });
  if (target.model === undefined && target.profile === undefined) {
    throw new SettingsUsageError('routing map needs a model or --profile <id>');
  }
  checkHarnessFields(harness, target);
  return { harness, preset, target };
}

function definedFields(target: Record<string, string | undefined>): Target {
  return Object.fromEntries(Object.entries(target).filter(([, v]) => v !== undefined));
}

function checkHarnessFields(harness: string, target: Target): void {
  if (harness === 'paseo') return;
  for (const [field, why] of Object.entries(PASEO_ONLY)) {
    if (target[field as keyof typeof PASEO_ONLY] !== undefined) {
      throw new SettingsUsageError(`--${field} is Paseo only (${why}), not for ${harness}`);
    }
  }
}

/** `codex/gpt-6-luna (thinking xhigh)` or `profile design-opus`. */
function describeTarget({ model, profile, mode, thinking }: Target): string {
  const head = model ?? `profile ${String(profile)}`;
  const extras = [
    model !== undefined && profile !== undefined ? `profile ${profile}` : undefined,
    mode === undefined ? undefined : `mode ${mode}`,
    thinking === undefined ? undefined : `thinking ${thinking}`,
  ].filter((part) => part !== undefined);
  return extras.length === 0 ? head : `${head} (${extras.join(', ')})`;
}

function mapPreset(paths: Paths, args: readonly string[]): string {
  const { harness, preset, target } = mapTarget(args);
  edit(paths, [{ path: ['routing', 'presets', harness, preset], value: target }]);
  return `route:${preset} → ${describeTarget(target)} for ${harness}`;
}

/**
 * `routing [map <harness> <preset> [model] [--thinking l] [--mode m] [--profile id]
 * | unmap <harness> <preset>]`. The old positional `[mode]` after the model still works.
 */
export function routingCommand(paths: Paths, args: readonly string[]): string {
  const [sub, harness, preset] = args;
  if (sub === undefined) {
    const store = ConfigFile.open(paths);
    return JSON.stringify(store.current.routing.presets, null, 2);
  }
  if (sub === 'map') return mapPreset(paths, args.slice(1));
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

/** `policies mode <policy> off|shadow|act [--scope claude-auto]`. */
export function setMode(paths: Paths, id: string, mode: string, scope?: string): string {
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new SettingsUsageError(`mode must be one of ${MODES.join(', ')}`);
  }
  if (scope === undefined) {
    edit(paths, [{ path: ['policies', id, 'mode'], value: mode }]);
    return `${id}: ${mode}`;
  }
  if (!(SCOPES as readonly string[]).includes(scope)) {
    throw new SettingsUsageError(`scope must be one of ${SCOPES.join(', ')}`);
  }
  edit(paths, [{ path: ['policies', id, 'scopes', scope, 'mode'], value: mode }]);
  return `${id} (${scope}): ${mode}`;
}
