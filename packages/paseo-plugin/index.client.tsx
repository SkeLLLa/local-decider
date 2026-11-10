import type { PluginClientContext } from '@getpaseo/plugin/client';

import { DecisionRowView } from './client/decision-row.tsx';
import { SettingsScreen } from './client/settings-screen.tsx';
import { StatsScreen } from './client/stats.tsx';
import { StatusFooterItem, StatusHeaderItem, StatusScreen } from './client/status.tsx';
import {
  ROW_KIND,
  type ServiceAction,
  ROW_VERSION,
  SETTINGS_SCREEN_ID,
  STATS_SCREEN_ID,
  STATUS_SCREEN_ID,
} from './shared/constants.ts';
import { DECIDE_USAGE, parseDecideArgs } from './shared/manual.ts';
import { decisionRowSchema } from './shared/row.ts';
import { decideRpc } from './shared/rpc.ts';

export default function contribute(client: PluginClientContext): () => void {
  const removers = [
    client.addSettingsScreen({
      id: SETTINGS_SCREEN_ID,
      title: 'Local decider',
      icon: 'Scale',
      Component: SettingsScreen,
    }),
    client.addScreen({ id: STATUS_SCREEN_ID, title: 'Local decider', Component: StatusScreen }),
    client.addScreen({ id: STATS_SCREEN_ID, title: 'Shadow stats', Component: StatsScreen }),
    // Both slots are registered; each renders only when Settings → Sidebar → Position picks it.
    client.addSidebarHeaderItem({
      id: 'status-header',
      title: 'Local decider (top)',
      Component: StatusHeaderItem,
    }),
    client.addSidebarFooterItem({
      id: 'status',
      title: 'Local decider',
      Component: StatusFooterItem,
    }),
    client.addTimelineRenderer({
      kind: ROW_KIND,
      version: ROW_VERSION,
      schema: decisionRowSchema,
      Component: DecisionRowView,
    }),
    ...commandCenterItems(client),
    client.addSlashCommand({
      name: 'decide',
      description: 'Ask the local decider (result appears in the chat)',
      argumentHint: '<policy> <text>',
      context: 'agent',
      async onSubmit(command) {
        const parsed = parseDecideArgs(command.args);
        if (parsed === null) {
          throw new Error(DECIDE_USAGE);
        }
        await command.rpc(decideRpc, { ...parsed, agentId: command.agent.id });
      },
    }),
  ];
  return () => {
    for (const remove of removers) {
      void remove();
    }
  };
}

const SERVICE_ITEMS = [
  { id: 'gateway-start', action: 'start', title: 'Local decider: start gateway', icon: 'Play' },
  { id: 'gateway-stop', action: 'stop', title: 'Local decider: stop gateway', icon: 'Square' },
  {
    id: 'gateway-restart',
    action: 'restart',
    title: 'Local decider: restart gateway',
    icon: 'RotateCw',
  },
] as const satisfies readonly { id: string; action: ServiceAction; title: string; icon: string }[];

function commandCenterItems(
  client: PluginClientContext,
): ReturnType<PluginClientContext['addCommandCenterItem']>[] {
  const keywords = ['local-decider', 'decider', 'system one'] as const;
  return [
    client.addCommandCenterItem({
      id: 'open-settings',
      title: 'Local decider: settings',
      icon: 'Settings',
      keywords,
      context: 'global',
      onSelect: (c) => c.openSettings(SETTINGS_SCREEN_ID),
    }),
    client.addCommandCenterItem({
      id: 'refresh-status',
      title: 'Local decider: refresh status',
      icon: 'RefreshCw',
      keywords,
      context: 'global',
      onSelect: (c) =>
        c.openScreen({ screenId: STATUS_SCREEN_ID, params: { refresh: String(Date.now()) } }),
    }),
    client.addCommandCenterItem({
      id: 'shadow-stats',
      title: 'Local decider: shadow stats',
      icon: 'ChartColumn',
      keywords,
      context: 'global',
      onSelect: (c) => c.openScreen({ screenId: STATS_SCREEN_ID }),
    }),
    ...SERVICE_ITEMS.map(({ action, ...item }) =>
      client.addCommandCenterItem({
        ...item,
        keywords,
        context: 'global',
        // The status screen runs it and toasts the result; stop asks for confirmation there.
        onSelect: (c) =>
          c.openScreen({
            screenId: STATUS_SCREEN_ID,
            params: { service: action, nonce: String(Date.now()) },
          }),
      }),
    ),
  ];
}
