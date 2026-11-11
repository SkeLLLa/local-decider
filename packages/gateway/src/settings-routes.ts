/**
 * Settings routes over config.yaml: read it, reload it after an outside edit, map routing
 * presets per harness, and fetch the prompt that has an agent write a policy variant.
 */
import { HARNESSES } from '@local-decider/core';

import type { PresetTarget } from './config.ts';
import type { Decider } from './decider.ts';
import { parseEngineConnection, type EngineConnection } from './engine-connection.ts';
import { EngineSwitchError, type EngineControl } from './engine-control.ts';

type SettingsHandler = (
  body: unknown,
  control: EngineControl,
  decider: Decider,
) => Promise<[number, unknown]>;

const PRESET = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const promptRoute = /^\/v1\/policies\/([a-z][a-z0-9_-]{0,63})\/prompt$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PresetUpdate {
  readonly harness: string;
  readonly preset: string;
  readonly target: PresetTarget | null;
}

const LIMITS = { model: 300, mode: 200, thinking: 100, profile: 200 } as const;

/** An optional non-empty string field of at most `max` characters; '' and null count as unset. */
function optionalText(
  record: Record<string, unknown>,
  key: keyof typeof LIMITS,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > LIMITS[key]) {
    throw new EngineSwitchError(
      400,
      `${key} must be a string of at most ${String(LIMITS[key])} characters`,
    );
  }
  return value;
}

/** A target needs a model or a profile; with neither, the mapping is removed. */
function parseTarget(record: Record<string, unknown>): PresetTarget | null {
  const fields = {
    model: optionalText(record, 'model'),
    mode: optionalText(record, 'mode'),
    thinking: optionalText(record, 'thinking'),
    profile: optionalText(record, 'profile'),
  };
  if (fields.model === undefined && fields.profile === undefined) {
    return null;
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

/** `{harness, preset, model?, profile?, mode?, thinking?}`; no model and no profile removes it. */
function parsePresetUpdate(body: unknown): PresetUpdate {
  const record = isRecord(body) ? body : {};
  const { harness, preset } = record;
  if (typeof harness !== 'string' || !(HARNESSES as readonly string[]).includes(harness)) {
    throw new EngineSwitchError(400, `harness must be one of ${HARNESSES.join(', ')}`);
  }
  if (typeof preset !== 'string' || !PRESET.test(preset)) {
    throw new EngineSwitchError(400, 'preset must match [a-z0-9][a-z0-9_.-]*');
  }
  return { harness, preset, target: parseTarget(record) };
}

const ROUTES: Readonly<Record<string, SettingsHandler>> = {
  'GET /v1/config': async (_body, c) => [200, c.describeSettings()],
  'POST /v1/config/reload': async (_body, c) => [200, await c.reloadConfig()],
  'POST /v1/config/engine': async (body, c) => {
    let connection: EngineConnection;
    try {
      connection = parseEngineConnection(body);
    } catch (error) {
      throw new EngineSwitchError(400, error instanceof Error ? error.message : 'invalid body');
    }
    const saved = await c.saveEngineConnection(connection);
    return [200, { engine: connection.engine, connection: saved }];
  },
  'POST /v1/routing/presets': async (body, c) => {
    const { harness, preset, target } = parsePresetUpdate(body);
    c.setRoutingPreset(harness, preset, target);
    return [200, { harness, presets: c.settings.routing.presets[harness as 'paseo'] ?? {} }];
  },
};

export function settingsHandler(key: string, path: string): SettingsHandler | undefined {
  const prompt = key.startsWith('GET ') ? promptRoute.exec(path)?.[1] : undefined;
  if (prompt !== undefined) {
    return async (_body, c, d) => [200, c.policyPrompt(prompt, d.policies)];
  }
  return ROUTES[key];
}
