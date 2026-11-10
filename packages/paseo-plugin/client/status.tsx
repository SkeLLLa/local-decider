import type { PluginScreenProps, PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsRow, SettingsSection, SidebarRow } from '@getpaseo/plugin/client/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import {
  DEFAULT_GATEWAY_URL,
  SERVICE_ACTIONS,
  type ServiceAction,
  STATUS_SCREEN_ID,
  type SidebarPosition,
} from '../shared/constants.ts';
import { shortModel } from '../shared/models.ts';
import { checkedAgo, statusLabel } from '../shared/poll.ts';
import { formatMs } from '../shared/stats.ts';
import { EngineControls } from './engine-state.tsx';
import { type Status, useDeciderValues, useGatewayStatus } from './hooks.ts';
import { headline, healthColor, QuickStatus } from './quick-status.tsx';
import { ServiceSection } from './service.tsx';
import { StatsSection } from './stats.tsx';
import { Button, Page, type Theme, Value } from './ui.tsx';

/**
 * The gateway status row. Registered in both the sidebar header and footer; each copy renders
 * only when the settings put it in its slot, so moving it needs no reload.
 */
function StatusItem({
  slot,
  ...props
}: PluginSidebarItemProps & { slot: SidebarPosition }): ReactNode {
  const { currentScreen, theme } = props;
  const values = useDeciderValues();
  const shown = values?.sidebar.position === slot;
  const { data } = useGatewayStatus(shown);
  if (values === null || !shown) {
    return null;
  }
  const { label, press } = values.sidebar;
  return (
    <SidebarRow
      icon="Scale"
      label={statusLabel(data, label)}
      active={currentScreen?.screenId === STATUS_SCREEN_ID}
      onPress={() =>
        press === 'popover'
          ? props.openPopover(QuickStatus)
          : props.openScreen({ screenId: STATUS_SCREEN_ID })
      }
      trailing={<StatusDot theme={theme} data={data} />}
    />
  );
}

export function StatusHeaderItem(props: PluginSidebarItemProps): ReactNode {
  return <StatusItem {...props} slot="header" />;
}

export function StatusFooterItem(props: PluginSidebarItemProps): ReactNode {
  return <StatusItem {...props} slot="footer" />;
}

function StatusDot({ theme, data }: { theme: Theme; data: Status | undefined }): ReactNode {
  return (
    <View
      style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: healthColor(theme, data) }}
    />
  );
}

function GatewaySection({ theme, data, isFetching, refetch }: GatewayProps): ReactNode {
  const now = useNow(5000);
  return (
    <SettingsSection
      title="Gateway"
      trailing={
        <Button
          theme={theme}
          variant="secondary"
          label={isFetching ? 'Checking…' : 'Refresh'}
          disabled={isFetching}
          onPress={refetch}
        />
      }
    >
      <SettingsCard>
        <SettingsRow label="Status" {...(data?.detail == null ? {} : { hint: data.detail })}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <StatusDot theme={theme} data={data} />
            <Value theme={theme}>{headline(data)}</Value>
          </View>
        </SettingsRow>
        <SettingsRow label="Model" {...(data?.model == null ? {} : { hint: data.model })}>
          <Value theme={theme}>{data?.model == null ? '—' : shortModel(data.model)}</Value>
        </SettingsRow>
        <SettingsRow label="Engine">
          <Value theme={theme}>{data?.engine ?? '—'}</Value>
        </SettingsRow>
        <SettingsRow label="Median latency">
          <Value theme={theme}>{formatMs(data?.p50Ms ?? null)}</Value>
        </SettingsRow>
        <SettingsRow label="Address">
          <Value theme={theme}>{data?.gatewayUrl ?? '—'}</Value>
        </SettingsRow>
        <SettingsRow label="Last checked">
          <Value theme={theme} muted>
            {checkedAgo(data?.checkedAt, now)}
          </Value>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

interface GatewayProps {
  readonly theme: Theme;
  readonly data: Status | undefined;
  readonly isFetching: boolean;
  readonly refetch: () => void;
}

/** Re-render every `ms` so relative times stay current. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** `?service=start&nonce=…` from a Command Center item. */
function serviceRequest(
  params: Readonly<Record<string, string>>,
): { action: ServiceAction; nonce: string } | null {
  const action = SERVICE_ACTIONS.find((a) => a === params['service']);
  return action === undefined ? null : { action, nonce: params['nonce'] ?? '' };
}

export function StatusScreen({ theme, layout, params }: PluginScreenProps): ReactNode {
  const { data, isFetching, refetch } = useGatewayStatus();
  const values = useDeciderValues();
  // `refresh` changes on every "Refresh status" command, forcing a check now.
  useEffect(() => {
    if (params['refresh'] !== undefined) {
      void refetch();
    }
  }, [params, refetch]);
  return (
    <Page theme={theme} compact={layout.compact}>
      <GatewaySection
        theme={theme}
        data={data}
        isFetching={isFetching}
        refetch={() => void refetch()}
      />
      <SettingsSection title="Engine">
        <EngineControls theme={theme} gatewayUrl={values?.gatewayUrl ?? DEFAULT_GATEWAY_URL} />
      </SettingsSection>
      <ServiceSection theme={theme} requested={serviceRequest(params)} />
      <StatsSection theme={theme} />
    </Page>
  );
}
