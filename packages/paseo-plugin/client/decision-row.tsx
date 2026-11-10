import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { useMemo, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { rowDetail, rowSummary, type DecisionRow } from '../shared/row.ts';

export function DecisionRowView({ item, theme }: PluginTimelineItemProps<DecisionRow>): ReactNode {
  const row = item.data;
  const styles = useMemo(() => {
    const accent = row.attention
      ? theme.colors.statusWarning
      : row.applied
        ? theme.colors.statusSuccess
        : theme.colors.border;
    return {
      box: {
        borderLeftWidth: 2,
        borderLeftColor: accent,
        paddingLeft: 8,
        paddingVertical: 2,
        gap: 2,
      },
      title: {
        color: row.attention ? theme.colors.statusWarning : theme.colors.foregroundMuted,
        fontSize: 12,
      },
      detail: { color: theme.colors.foregroundMuted, fontSize: 11 },
    };
  }, [row.attention, row.applied, theme]);

  return (
    <View
      style={styles.box}
      accessibilityLabel={`Local decider: ${rowSummary(row)}. ${rowDetail(row)}`}
    >
      <Text style={styles.title} numberOfLines={1}>
        {row.attention ? '⚑ ' : '◆ '}
        {rowSummary(row)}
      </Text>
      <Text style={styles.detail} numberOfLines={1}>
        {rowDetail(row)}
      </Text>
    </View>
  );
}
