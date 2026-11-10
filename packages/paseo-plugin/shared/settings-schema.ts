/** The settings document, kept free of Paseo imports so tests can load it. */
import { z } from 'zod';

import {
  DEFAULT_GATEWAY_URL,
  DEVICES,
  PLUGIN_MODES,
  ROW_VISIBILITY,
  SIDEBAR_LABELS,
  SIDEBAR_POSITIONS,
  SIDEBAR_PRESS,
  STRANDS_MODELS,
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
  /** Decision model the gateway should serve; '' leaves the gateway's config.yaml choice. */
  model: z.string().max(300).default(''),
  device: z.enum(DEVICES).default('auto'),
  /** Switch the gateway back to `model` when it restarts with another one. */
  keepModel: z.boolean().default(false),
  modes: z.object({ 'turn-outcome': mode, 'permission': mode, 'routing': mode }).prefault({}),
  presets: z.object({ fast: preset, standard: preset, deep: preset }).prefault({}),
  injectMcp: z.boolean().default(false),
  sidebar,
  rows,
});

/** v1 stored an engine preference and always a model; neither changed what the gateway ran. */
export function migrateV1(values: unknown): unknown {
  if (typeof values !== 'object' || values === null) {
    return {};
  }
  const { engine: _engine, ...rest } = values as Record<string, unknown>;
  const untouched = rest['model'] === STRANDS_MODELS[0].id && (rest['device'] ?? 'auto') === 'auto';
  return untouched ? { ...rest, model: '' } : rest;
}

export type DeciderSettings = z.output<typeof settingsSchema>;
