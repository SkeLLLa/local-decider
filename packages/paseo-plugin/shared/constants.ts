/** Plain values shared by the daemon and app bundles. */

export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8765';
/** Name of the injected MCP server and prefix of every timeline row id. */
export const MCP_SERVER_NAME = 'local-decider';

export const ROW_KIND = 'decision';
export const ROW_VERSION = 1;

/** Policies the plugin drives from hooks; each has its own plugin-side mode. */
export const HOOK_POLICIES = ['turn-outcome', 'permission', 'routing'] as const;

export const PLUGIN_MODES = ['off', 'shadow', 'act'] as const;

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

/** Installs the gateway's user service; shown, never run. */
export const INSTALL_SERVICE_COMMAND = 'local-decider gateway start';

/** What the service buttons do; the argv behind each is fixed daemon-side (server/service.ts). */
export const SERVICE_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export const SETTINGS_SCREEN_ID = 'settings';
/** The same settings UI as a plugin screen, so surfaces without `openSettings` can open it. */
export const SETTINGS_PAGE_ID = 'settings-page';
export const STATUS_SCREEN_ID = 'status';
export const STATS_SCREEN_ID = 'stats';
