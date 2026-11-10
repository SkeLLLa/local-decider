import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { statsRpc } from '../shared/rpc.ts';
import { Button, type Theme } from './ui.tsx';

/** `GET /v1/stats` through the daemon, fetched on demand (it can be slow on big shadow logs). */
export function StatsPanel({
  theme,
  autoLoad = false,
}: {
  theme: Theme;
  autoLoad?: boolean;
}): ReactNode {
  const stats = useRpc(statsRpc);
  const query = useQuery({
    queryKey: ['local-decider', 'stats'],
    queryFn: async () => stats({}),
    enabled: autoLoad,
    retry: false,
    staleTime: 30_000,
  });
  const body = query.data?.text ?? (query.error === null ? '' : String(query.error));
  return (
    <View style={{ gap: 8 }}>
      <Button
        theme={theme}
        label={
          query.isFetching ? 'Loading…' : query.data === undefined ? 'Load stats' : 'Reload stats'
        }
        disabled={query.isFetching}
        onPress={() => void query.refetch()}
      />
      {body === '' ? null : (
        <Text
          selectable
          style={{
            color: query.data?.ok === true ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          {body}
        </Text>
      )}
    </View>
  );
}

export function StatsScreen({ theme, layout }: PluginScreenProps): ReactNode {
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      body: { padding: layout.compact ? 16 : 24, gap: 12 },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme, layout.compact],
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.muted}>
        Agreement between shadow decisions and what actually happened, from the gateway's shadow
        log. The same report is available as `local-decider stats`.
      </Text>
      <StatsPanel theme={theme} autoLoad />
    </ScrollView>
  );
}
