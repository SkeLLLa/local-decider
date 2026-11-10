/** Plain values shared by the daemon and app bundles. */

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8765';
/** Name of the injected MCP server and prefix of every timeline row id. */
export const MCP_SERVER_NAME = 'local-decider';

export const ROW_KIND = 'decision';
export const ROW_VERSION = 1;

/** Policies the plugin drives from hooks; each has its own plugin-side mode. */
export const HOOK_POLICIES = ['turn-outcome', 'permission', 'routing'] as const;

export const PLUGIN_MODES = ['off', 'shadow', 'act'] as const;

export const DEVICES = ['auto', 'cpu', 'mlx', 'mps', 'cuda'] as const;
export type Device = (typeof DEVICES)[number];

/** Fallback model list (the gateway's `GET /models` wins), with approximate memory needs. */
export const STRANDS_MODELS = [
  { id: 'StrandsAgents/strands-decider-2B-qwen3.5-v1-2610', memoryGb: 8 },
  { id: 'StrandsAgents/strands-decider-2B-hobson-v21', memoryGb: 8 },
  { id: 'StrandsAgents/strands-decider-E2B-gemma4-v1-2610', memoryGb: 19 },
  { id: 'StrandsAgents/strands-decider-E4B-gemma4-v1-2610', memoryGb: 30 },
  { id: 'StrandsAgents/strands-decider-12B-gemma4-v1-2610', memoryGb: 46 },
] as const;

/** Where the status item sits in the sidebar, or hidden. */
export const SIDEBAR_POSITIONS = ['footer', 'header', 'hidden'] as const;
export type SidebarPosition = (typeof SIDEBAR_POSITIONS)[number];
/** What the status item's label shows next to the health dot. */
export const SIDEBAR_LABELS = ['full', 'model', 'latency', 'minimal'] as const;
export type SidebarLabel = (typeof SIDEBAR_LABELS)[number];
export const SIDEBAR_PRESS = ['popover', 'screen'] as const;

/** Which decision rows the daemon appends to agent chats. `/decide` results always show. */
export const ROW_VISIBILITY = ['all', 'notable', 'off'] as const;
export type RowVisibility = (typeof ROW_VISIBILITY)[number];

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
