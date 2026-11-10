/**
 * Settings routes over config.yaml: read it, reload it after an outside edit, map routing
 * presets per harness, and fetch the prompt that has an agent write a policy variant.
 */
import { HARNESSES } from '@local-decider/core';

import type { Decider } from './decider.ts';
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
  readonly target: { model: string; mode?: string } | null;
}

function parseTarget(model: unknown, mode: unknown): PresetUpdate['target'] {
  if (model === null) {
    return null;
  }
  if (typeof model !== 'string' || model.length === 0 || model.length > 300) {
    throw new EngineSwitchError(400, 'model must be a model id or null');
  }
  if (mode !== undefined && (typeof mode !== 'string' || mode.length > 200)) {
    throw new EngineSwitchError(400, 'mode must be a string');
  }
  return { model, ...(mode === undefined || mode === '' ? {} : { mode }) };
}

/** `{harness, preset, model, mode?}`; `model: null` removes the mapping. */
function parsePresetUpdate(body: unknown): PresetUpdate {
  const { harness, preset, model, mode } = isRecord(body) ? body : {};
  if (typeof harness !== 'string' || !(HARNESSES as readonly string[]).includes(harness)) {
    throw new EngineSwitchError(400, `harness must be one of ${HARNESSES.join(', ')}`);
  }
  if (typeof preset !== 'string' || !PRESET.test(preset)) {
    throw new EngineSwitchError(400, 'preset must match [a-z0-9][a-z0-9_.-]*');
  }
  return { harness, preset, target: parseTarget(model, mode) };
}

const ROUTES: Readonly<Record<string, SettingsHandler>> = {
  'GET /v1/config': async (_body, c) => [200, c.describeSettings()],
  'POST /v1/config/reload': async (_body, c) => [200, await c.reloadConfig()],
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
