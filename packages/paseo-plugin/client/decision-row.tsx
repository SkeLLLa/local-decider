import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { rowDetail, rowSummary, type DecisionRow } from '../shared/row.ts';
import { feedbackRpc } from '../shared/rpc.ts';
import { useDeciderValues } from './hooks.ts';
import type { Theme } from './ui.tsx';

/**
 * "Right answer?" chips: one per option of the primary question. Tapping one reports it to the
 * gateway as a `user` outcome, the ground truth behind `local-decider stats`. Not on permission
 * rows, whose outcome is the user's Accept/Deny.
 */
function Feedback({
  row,
  agentId,
  theme,
}: {
  row: DecisionRow;
  agentId: string;
  theme: Theme;
}): ReactNode {
  const send = useRpc(feedbackRpc);
  const toast = useToast();
  const [sent, setSent] = useState<string | null>(row.feedback);
  const [busy, setBusy] = useState(false);
  const chosen = row.feedback ?? sent;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 11 };
  if (chosen !== null) {
    return (
      <Text style={muted}>
        {chosen === row.answer ? '✓ You confirmed this answer' : `✗ You said: ${chosen}`}
      </Text>
    );
  }
  const report = (outcome: string): void => {
    setBusy(true);
    send({ agentId, row, outcome })
      .then(
        () => setSent(outcome),
        (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <Text style={muted}>Right answer?</Text>
      {row.options.map((option) => {
        const predicted = option === row.answer;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={`The right answer was ${option}`}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={() => report(option)}
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 4,
              borderWidth: 1,
              borderColor: predicted ? theme.colors.accent : theme.colors.border,
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text style={{ ...muted, color: predicted ? theme.colors.foreground : muted.color }}>
              {option}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The user's own answer to the permission prompt, reported by `agent.permission.after`. */
function permissionFeedback(resolution: string): string {
  if (resolution === 'allow') {
    return '✓ You allowed';
  }
  return resolution === 'deny' ? '✗ You denied' : `You answered: ${resolution}`;
}

export function DecisionRowView({
  item,
  theme,
  agentId,
}: PluginTimelineItemProps<DecisionRow>): ReactNode {
  const row = item.data;
  const values = useDeciderValues();
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
  const details = values?.rows.details ?? true;
  // Permission rows have no chips: the user's Accept/Deny is the one ground-truth outcome.
  const permission = row.source === 'permission';
  const feedback =
    !permission && (values?.rows.feedback ?? true) && row.options.length > 1 && row.error === null;

  return (
    <View
      style={styles.box}
      accessibilityLabel={`Local decider: ${rowSummary(row)}. ${rowDetail(row)}`}
    >
      <Text style={styles.title} numberOfLines={1}>
        {row.attention ? '⚑ ' : '◆ '}
        {rowSummary(row)}
      </Text>
      {details ? (
        <Text style={styles.detail} numberOfLines={1}>
          {rowDetail(row)}
        </Text>
      ) : null}
      {permission && row.feedback !== null ? (
        <Text style={styles.detail}>{permissionFeedback(row.feedback)}</Text>
      ) : null}
      {feedback ? <Feedback row={row} agentId={agentId} theme={theme} /> : null}
    </View>
  );
}
