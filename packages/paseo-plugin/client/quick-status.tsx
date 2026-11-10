/** The sidebar status popover: health at a glance, policy modes, and a way to the details. */
import type { PluginPopoverProps } from '@getpaseo/plugin/client';
import { useMemo, type ReactNode } from 'react';
import { Text, type TextStyle, View, type ViewStyle } from 'react-native';

import { GATEWAY_COMMANDS, HOOK_POLICIES, STATUS_SCREEN_ID } from '../shared/constants.ts';
import { shortModel } from '../shared/models.ts';
import { type Status, useDeciderValues, useGatewayStatus } from './hooks.ts';
import { Button, type Theme } from './ui.tsx';

export function healthColor(theme: Theme, data: Status | undefined): string {
  if (data === undefined) {
    return theme.colors.foregroundMuted;
  }
  if (!data.up) {
    return theme.colors.statusDanger;
  }
  return data.status === 'ok' ? theme.colors.statusSuccess : theme.colors.statusWarning;
}

const STATE_LABELS: Record<string, string> = {
  ready: 'Ready',
  starting: 'Loading model',
  failed: 'Engine failed',
  stopped: 'Engine stopped',
};

export function headline(data: Status | undefined): string {
  if (data === undefined) {
    return 'Checking…';
  }
  if (!data.up) {
    return 'Gateway unreachable';
  }
  const state = data.engineState ?? (data.status === 'ok' ? 'ready' : 'starting');
  return STATE_LABELS[state] ?? state;
}

const POLICY_LABELS: Record<(typeof HOOK_POLICIES)[number], string> = {
  'turn-outcome': 'Turn outcome',
  'permission': 'Permission',
  'routing': 'Routing',
};

const MODE_LABELS = { off: 'Off', shadow: 'Shadow', act: 'Act' } as const;

function ModePill({ mode, theme }: { mode: keyof typeof MODE_LABELS; theme: Theme }): ReactNode {
  const act = mode === 'act';
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 1,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: act ? theme.colors.statusWarning : theme.colors.border,
        opacity: mode === 'off' ? 0.6 : 1,
      }}
    >
      <Text
        style={{
          color: act ? theme.colors.statusWarning : theme.colors.foregroundMuted,
          fontSize: 11,
          lineHeight: 16,
        }}
      >
        {MODE_LABELS[mode]}
      </Text>
    </View>
  );
}

interface Styles {
  readonly root: ViewStyle;
  readonly section: ViewStyle;
  readonly divider: ViewStyle;
  readonly headerRow: ViewStyle;
  readonly dot: ViewStyle;
  readonly title: TextStyle;
  readonly latency: TextStyle;
  readonly sub: TextStyle;
  readonly row: ViewStyle;
  readonly label: TextStyle;
  readonly caption: TextStyle;
  readonly buttons: ViewStyle;
}

function useStyles(theme: Theme): Styles {
  return useMemo(
    () => ({
      root: { width: 280, paddingVertical: 12, gap: 12 },
      section: { paddingHorizontal: 16, gap: 6 },
      divider: { height: 1, backgroundColor: theme.colors.border },
      headerRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
      dot: { width: 8, height: 8, borderRadius: 4 },
      title: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '600' as const,
      },
      latency: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 20 },
      sub: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, paddingLeft: 16 },
      row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        minHeight: 22,
      },
      label: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
      caption: { color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
      buttons: { flexDirection: 'row' as const, gap: 8 },
    }),
    [theme],
  );
}

function subtitle(data: Status | undefined): string | null {
  if (data === undefined) {
    return null;
  }
  if (!data.up) {
    return `Run ${GATEWAY_COMMANDS.start} on the daemon machine.`;
  }
  return data.detail ?? (data.model === null ? null : shortModel(data.model));
}

export function QuickStatus(props: PluginPopoverProps): ReactNode {
  const { theme } = props;
  const styles = useStyles(theme);
  const { data, isFetching, refetch } = useGatewayStatus();
  const values = useDeciderValues();
  const sub = subtitle(data);
  return (
    <View style={styles.root}>
      <View style={styles.section}>
        <View style={styles.headerRow}>
          <View style={[styles.dot, { backgroundColor: healthColor(theme, data) }]} />
          <Text style={styles.title} numberOfLines={1}>
            {headline(data)}
          </Text>
          {data?.up === true && data.p50Ms !== null ? (
            <Text style={styles.latency}>{`p50 ${Math.round(data.p50Ms)} ms`}</Text>
          ) : null}
        </View>
        {sub === null ? null : (
          <Text style={styles.sub} numberOfLines={2} accessibilityLabel={data?.model ?? sub}>
            {sub}
          </Text>
        )}
      </View>
      <View style={styles.divider} />
      <View style={styles.section}>
        {HOOK_POLICIES.map((policy) => (
          <View key={policy} style={styles.row}>
            <Text style={styles.label}>{POLICY_LABELS[policy]}</Text>
            {values === null ? (
              <Text style={styles.caption}>…</Text>
            ) : (
              <ModePill mode={values.modes[policy]} theme={theme} />
            )}
          </View>
        ))}
      </View>
      <View style={styles.divider} />
      <View style={[styles.section, { gap: 10 }]}>
        <Text style={styles.caption} numberOfLines={1}>
          {data?.gatewayUrl ?? ' '}
        </Text>
        <View style={styles.buttons}>
          <Button
            theme={theme}
            variant="secondary"
            grow
            label={isFetching ? 'Checking…' : 'Refresh'}
            disabled={isFetching}
            onPress={() => void refetch()}
          />
          <Button
            theme={theme}
            variant="secondary"
            grow
            label="Details"
            onPress={() => {
              props.close();
              props.openScreen({ screenId: STATUS_SCREEN_ID });
            }}
          />
        </View>
      </View>
    </View>
  );
}
