import type { PluginScreenProps, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { copyText, SidebarRow, useToast } from '@getpaseo/plugin/client/ui';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { z } from 'zod';

import { GATEWAY_COMMANDS, STATUS_SCREEN_ID } from '../shared/constants.ts';
import { nextPollDelay, statusLabel } from '../shared/poll.ts';
import { shortModel } from '../shared/row.ts';
import { statusRpc } from '../shared/rpc.ts';
import { StatsPanel } from './stats.tsx';
import { Button, Field, type Theme } from './ui.tsx';

type Status = z.output<typeof statusRpc.output>;

const STATUS_QUERY_KEY = ['local-decider', 'status'] as const;

/** Shared, polled gateway status: 15 s while up, backing off to 2 min while down. */
function useGatewayStatus(): UseQueryResult<Status> {
  const status = useRpc(statusRpc);
  return useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: async () => status({}),
    retry: false,
    staleTime: 5000,
    refetchInterval: (query) =>
      nextPollDelay(query.state.data?.downStreak ?? query.state.fetchFailureCount),
  });
}

export function StatusFooterItem(props: PluginSidebarItemProps): ReactNode {
  const { currentScreen, theme } = props;
  const { data } = useGatewayStatus();
  const color =
    data === undefined
      ? theme.colors.foregroundMuted
      : data.up
        ? theme.colors.statusSuccess
        : theme.colors.statusDanger;
  return (
    <SidebarRow
      icon="Scale"
      label={statusLabel(data, shortModel)}
      active={currentScreen?.screenId === STATUS_SCREEN_ID}
      onPress={() => props.openScreen({ screenId: STATUS_SCREEN_ID })}
      trailing={<View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />}
    />
  );
}

function CommandLine({ command, theme }: { command: string; theme: Theme }): ReactNode {
  const toast = useToast();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${command}`}
      onPress={() => {
        copyText(command).then(
          () => toast.show('Copied', { variant: 'success' }),
          () => toast.error('Copy is not available here'),
        );
      }}
      style={{
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontFamily: 'monospace' }}>{command}</Text>
    </Pressable>
  );
}

export function StatusScreen({ theme, layout, params }: PluginScreenProps): ReactNode {
  const query = useGatewayStatus();
  const { data, refetch } = query;
  // `refresh` changes on every "Refresh status" command, forcing a check now.
  useEffect(() => {
    if (params['refresh'] !== undefined) {
      void refetch();
    }
  }, [params, refetch]);
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: layout.compact ? 16 : 24, gap: 12 },
      heading: { color: theme.colors.foreground, fontSize: 16, fontWeight: '600' as const },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.heading}>Gateway</Text>
      <Field
        theme={theme}
        label="Status"
        value={data === undefined ? 'checking…' : data.up ? data.status : 'unreachable'}
      />
      <Field theme={theme} label="URL" value={data?.gatewayUrl ?? ''} />
      <Field theme={theme} label="Engine" value={data?.engine ?? '—'} />
      <Field theme={theme} label="Model" value={data?.model ?? '—'} />
      <Field
        theme={theme}
        label="p50"
        value={data?.p50Ms == null ? '—' : `${Math.round(data.p50Ms)} ms`}
      />
      <Field theme={theme} label="Checked" value={data?.checkedAt ?? '—'} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          theme={theme}
          label={query.isFetching ? 'Checking…' : 'Refresh'}
          onPress={() => void refetch()}
        />
      </View>
      <Text style={styles.heading}>Start or stop the gateway</Text>
      <Text style={styles.muted}>
        The plugin never starts processes. Run these in a terminal on the daemon machine (tap to
        copy).
      </Text>
      <CommandLine theme={theme} command={GATEWAY_COMMANDS.start} />
      <CommandLine theme={theme} command={GATEWAY_COMMANDS.stop} />
      <Text style={styles.heading}>Shadow statistics</Text>
      <StatsPanel theme={theme} />
    </ScrollView>
  );
}
