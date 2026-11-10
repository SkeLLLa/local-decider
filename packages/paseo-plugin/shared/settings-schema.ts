/** The settings document, kept free of Paseo imports so tests can load it. */
import { z } from 'zod';

import {
  DEFAULT_GATEWAY_URL,
  PLUGIN_MODES,
  ROW_VISIBILITY,
  SIDEBAR_LABELS,
  SIDEBAR_POSITIONS,
  SIDEBAR_PRESS,
} from './constants.ts';

const mode = z.enum(PLUGIN_MODES).default('shadow');

/** `provider/model` from `providers.listModels()`, or '' for "not mapped". */
const preset = z
  .object({
    model: z.string().max(300).default(''),
    modeId: z.string().max(200).default(''),
  })
  .prefault({});

const sidebar = z
  .object({
    position: z.enum(SIDEBAR_POSITIONS).default('footer'),
    label: z.enum(SIDEBAR_LABELS).default('full'),
    press: z.enum(SIDEBAR_PRESS).default('popover'),
  })
  .prefault({});

const rows = z
  .object({
    show: z.enum(ROW_VISIBILITY).default('all'),
    /** Second line with model, latency and notes. */
    details: z.boolean().default(true),
    /** "Was this right?" buttons that report the true answer to the gateway. */
    feedback: z.boolean().default(true),
  })
  .prefault({});

export const settingsSchema = z.object({
  gatewayUrl: z.string().max(500).default(DEFAULT_GATEWAY_URL),
  modes: z.object({ 'turn-outcome': mode, 'permission': mode, 'routing': mode }).prefault({}),
  presets: z.object({ fast: preset, standard: preset, deep: preset }).prefault({}),
  injectMcp: z.boolean().default(false),
  /** Ask the gateway to load its model when Paseo (and so this plugin) starts. */
  preloadOnStart: z.boolean().default(false),
  sidebar,
  rows,
});

/**
 * v1 stored an engine preference; v2 a model, device and "keep after restarts" switch. The
 * gateway now owns and persists the engine and model choice, so v3 drops all four.
 */
export function migrateSettings(values: unknown): unknown {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return {};
  }
  const {
    engine: _engine,
    model: _model,
    device: _device,
    keepModel: _keepModel,
    ...rest
  } = values as Record<string, unknown>;
  return rest;
}

export const SETTINGS_VERSION = 3;

/** `defineSettings` migrate hook: anything stored before v3 loses the engine-choice fields. */
export function migrateStored(values: unknown, fromVersion: number): unknown {
  return fromVersion < SETTINGS_VERSION ? migrateSettings(values) : values;
}

export type DeciderSettings = z.output<typeof settingsSchema>;
