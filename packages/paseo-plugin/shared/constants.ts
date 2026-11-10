/** Plain values shared by the daemon and app bundles. */

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8765';
/** Name of the injected MCP server and prefix of every timeline row id. */
export const MCP_SERVER_NAME = 'local-decider';

export const ROW_KIND = 'decision';
export const ROW_VERSION = 1;

/** Policies the plugin drives from hooks; each has its own plugin-side mode. */
export const HOOK_POLICIES = ['turn-outcome', 'permission', 'routing'] as const;

export const PLUGIN_MODES = ['off', 'shadow', 'act'] as const;

export const ENGINES = ['strands-decider', 'systemone-remote', 'llm-logprobs'] as const;
export const DEVICES = ['auto', 'cpu', 'mlx', 'mps', 'cuda'] as const;

export const STRANDS_MODELS = [
  'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610',
  'StrandsAgents/strands-decider-2B-hobson-v21',
  'StrandsAgents/strands-decider-E2B-gemma4-v1-2610',
  'StrandsAgents/strands-decider-E4B-gemma4-v1-2610',
  'StrandsAgents/strands-decider-12B-gemma4-v1-2610',
] as const;
export const DEFAULT_MODEL = STRANDS_MODELS[0];

export const ROUTING_PRESETS = ['fast', 'standard', 'deep'] as const;
export type RoutingPreset = (typeof ROUTING_PRESETS)[number];

/** Shown, never run: the plugin does not spawn processes. */
export const GATEWAY_COMMANDS = {
  start: 'local-decider gateway start',
  stop: 'local-decider gateway stop',
} as const;

export const SETTINGS_SCREEN_ID = 'settings';
export const STATUS_SCREEN_ID = 'status';
export const STATS_SCREEN_ID = 'stats';
