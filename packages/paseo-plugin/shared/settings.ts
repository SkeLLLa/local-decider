import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

import { DEFAULT_GATEWAY_URL, DEFAULT_MODEL, DEVICES, ENGINES, PLUGIN_MODES } from './constants.ts';

const mode = z.enum(PLUGIN_MODES).default('shadow');

/** `provider/model` from `providers.listModels()`, or '' for "not mapped". */
const preset = z
  .object({
    model: z.string().max(300).default(''),
    modeId: z.string().max(200).default(''),
  })
  .prefault({});

/**
 * Host settings. Plain JSON that every authorized client can read: never put a token here. A
 * remote gateway token comes only from `LOCAL_DECIDER_TOKEN` in the daemon's environment.
 */
export const deciderSettings = defineSettings({
  id: 'local-decider',
  scope: 'host',
  version: 1,
  schema: z.object({
    gatewayUrl: z.string().max(500).default(DEFAULT_GATEWAY_URL),
    /** Preferences shown next to what the gateway reports; the gateway config decides. */
    engine: z.enum(ENGINES).default('strands-decider'),
    model: z.string().max(300).default(DEFAULT_MODEL),
    device: z.enum(DEVICES).default('auto'),
    modes: z.object({ 'turn-outcome': mode, 'permission': mode, 'routing': mode }).prefault({}),
    presets: z.object({ fast: preset, standard: preset, deep: preset }).prefault({}),
    injectMcp: z.boolean().default(false),
  }),
});

export type DeciderSettings = z.output<typeof deciderSettings.schema>;
