import type { PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  labelChoices,
  permissionNote,
  rowDetail,
  rowLabelKind,
  rowSummary,
  type DecisionRow,
  type LabelChoice,
} from '../shared/row.ts';
import { feedbackRpc, permissionLabelRpc } from '../shared/rpc.ts';
import { useDeciderValues } from './hooks.ts';
import type { Theme } from './ui.tsx';

type ChipTheme = Pick<Theme, 'colors'>;

function RowChip({
  label,
  accessibilityLabel,
  highlighted,
  busy,
  onPress,
  theme,
}: {
  label: string;
  accessibilityLabel: string;
  highlighted: boolean;
  busy: boolean;
  onPress: () => void;
  theme: ChipTheme;
}): ReactNode {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 11 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: highlighted ? theme.colors.accent : theme.colors.border,
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text style={{ ...muted, color: highlighted ? theme.colors.foreground : muted.color }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * "Right answer?" chips: one per option of the primary question. Tapping one reports it to the
 * gateway as a `user` outcome, the ground truth behind `local-decider stats`. Permission rows
 * get label chips instead (`PermissionLabels`): their outcome is the user's Accept/Decline.
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
    settle(send({ agentId, row, outcome }), () => setSent(outcome), toast, setBusy);
  };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <Text style={muted}>Right answer?</Text>
      {row.options.map((option) => (
        <RowChip
          key={option}
          label={option}
          accessibilityLabel={`The right answer was ${option}`}
          highlighted={option === row.answer}
          busy={busy}
          onPress={() => report(option)}
          theme={theme}
        />
      ))}
    </View>
  );
}

function settle(
  request: Promise<unknown>,
  onDone: () => void,
  toast: { error: (message: string) => void },
  setBusy: (busy: boolean) => void,
): void {
  setBusy(true);
  request
    .then(onDone, (error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error)),
    )
    .finally(() => setBusy(false));
}

const LABEL_TEXT: Record<LabelChoice, { label: string; accessibility: string }> = {
  safe: { label: 'Not a safety issue', accessibility: 'The decline was not a safety issue' },
  unsafe: { label: 'Unsafe', accessibility: 'This request was unsafe' },
  skip: { label: 'Skip', accessibility: "Don't label this" },
};

const MARK_UNSAFE = {
  label: 'Mark unsafe',
  accessibility:
    'Mark this auto-allowed request unsafe; past allows stop lowering its threshold for 14 days',
};

/**
 * Label chips on a permission row: after a decline or interrupt (safety issue or not), or on a
 * keyed auto-allow ("Mark unsafe"). Expiry is checked at render time only; the daemon decides.
 */
function PermissionLabels({
  row,
  agentId,
  theme,
  onLabelled,
}: {
  row: DecisionRow;
  agentId: string;
  theme: Theme;
  onLabelled: (label: LabelChoice) => void;
}): ReactNode {
  const send = useRpc(permissionLabelRpc);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const choices = labelChoices(row, Date.now());
  if (choices.length === 0) {
    return null;
  }
  const autoAllowed = rowLabelKind(row) === 'auto-allowed';
  const report = (label: LabelChoice): void => {
    settle(send({ agentId, rowId: row.rowId, label }), () => onLabelled(label), toast, setBusy);
  };
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {autoAllowed ? null : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Why?</Text>
      )}
      {choices.map((choice) => {
        const text = autoAllowed ? MARK_UNSAFE : LABEL_TEXT[choice];
        return (
          <RowChip
            key={choice}
            label={text.label}
            accessibilityLabel={text.accessibility}
            highlighted={false}
            busy={busy}
            onPress={() => report(choice)}
            theme={theme}
          />
        );
      })}
    </View>
  );
}

/**
 * What follows the summary: a permission row gets its answer line and label chips, any other row
 * "Right answer?" chips. The user's Accept/Decline is a permission row's outcome.
 */
function RowAnswer({
  row,
  shown,
  chips,
  agentId,
  theme,
  detailStyle,
  onLabelled,
}: {
  row: DecisionRow;
  shown: DecisionRow;
  chips: boolean;
  agentId: string;
  theme: Theme;
  detailStyle: object;
  onLabelled: (label: LabelChoice) => void;
}): ReactNode {
  const permission = row.source === 'permission';
  const note = permission ? permissionNote(shown) : null;
  const wantsChips = chips && row.error === null;
  return (
    <>
      {note === null ? null : <Text style={detailStyle}>{note}</Text>}
      {permission && wantsChips ? (
        <PermissionLabels row={shown} agentId={agentId} theme={theme} onLabelled={onLabelled} />
      ) : null}
      {!permission && wantsChips && row.options.length > 1 ? (
        <Feedback row={row} agentId={agentId} theme={theme} />
      ) : null}
    </>
  );
}

function useRowStyles(row: DecisionRow, theme: Theme): Record<'box' | 'title' | 'detail', object> {
  return useMemo(() => {
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
}

export function DecisionRowView({
  item,
  theme,
  agentId,
}: PluginTimelineItemProps<DecisionRow>): ReactNode {
  const values = useDeciderValues();
  const [labelled, setLabelled] = useState<LabelChoice | null>(null);
  const row = item.data;
  const shown: DecisionRow = { ...row, label: row.label ?? labelled };
  const styles = useRowStyles(row, theme);
  const details = values?.rows.details ?? true;
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
      <RowAnswer
        row={row}
        shown={shown}
        chips={values?.rows.feedback ?? true}
        agentId={agentId}
        theme={theme}
        detailStyle={styles.detail}
        onLabelled={setLabelled}
      />
    </View>
  );
}
