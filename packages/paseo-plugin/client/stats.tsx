import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { useRpc } from '@getpaseo/plugin/client';
import {
  copyText,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  useToast,
} from '@getpaseo/plugin/client/ui';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { z } from 'zod';

import { statsRpc } from '../shared/rpc.ts';
import {
  actionSummary,
  formatMs,
  formatPercent,
  promptTimeSummary,
  savingsSummary,
  type PolicyStats,
} from '../shared/stats.ts';
import { useQueryKey } from './host-scope.ts';
import { Button, Page, type Theme, Value } from './ui.tsx';

function policyHint(s: PolicyStats): string {
  const parts = [`${String(s.decisions)} decisions`];
  if (s.errors > 0) {
    parts.push(`${String(s.errors)} errors`);
  }
  if (s.enforced > 0) {
    parts.push(`${String(s.enforced)} enforced`);
  }
  const actions = actionSummary(s.actions);
  if (actions !== '') {
    parts.push(actions);
  }
  return parts.join(' · ');
}

function PolicyRow({ stats, theme }: { stats: PolicyStats; theme: Theme }): ReactNode {
  const agreement =
    stats.labelled === 0
      ? 'no feedback yet'
      : `${formatPercent(stats.agreement)} agree · ${String(stats.labelled)} labelled`;
  return (
    <SettingsRow label={stats.policy} hint={policyHint(stats)}>
      <View style={{ alignItems: 'flex-end', gap: 2, flexShrink: 1 }}>
        <Value theme={theme}>{`p50 ${formatMs(stats.latencyP50Ms)}`}</Value>
        <Value theme={theme} muted>
          {agreement}
        </Value>
      </View>
    </SettingsRow>
  );
}

/** Savings lines under a policy: potential (shadow) and realized (enforced), when any. */
function SavingsRows({ stats }: { stats: PolicyStats }): ReactNode {
  const potential = stats.savings === null ? '' : savingsSummary(stats.savings.potential);
  const realized = stats.savings === null ? '' : savingsSummary(stats.savings.realized);
  const prompts = promptTimeSummary(stats.promptTime);
  return (
    <>
      {potential === '' ? null : (
        <SettingsRow
          label={`${stats.policy}: potential savings`}
          hint={`${potential} — upper bound: assumes the routed model would use the same tokens and succeed`}
        />
      )}
      {realized === '' ? null : (
        <SettingsRow label={`${stats.policy}: realized savings`} hint={realized} />
      )}
      {prompts === '' ? null : (
        <SettingsRow
          label={`${stats.policy}: prompts it would have allowed`}
          hint={`${prompts} spent answering them`}
        />
      )}
    </>
  );
}

/** Policy rows, or the reason there are none, plus the raw-report copy button. */
type StatsResult = z.output<typeof statsRpc.output>;

function StatsCard({
  query,
  theme,
}: {
  query: UseQueryResult<StatsResult>;
  theme: Theme;
}): ReactNode {
  const toast = useToast();
  const data = query.data;
  return (
    <SettingsCard>
      {data === undefined ? (
        <SettingsRow
          label={query.error === null ? 'Loading…' : 'Statistics unavailable'}
          {...(query.error === null ? {} : { hint: String(query.error) })}
        />
      ) : !data.ok ? (
        <SettingsRow label="Statistics unavailable" hint={data.text} />
      ) : data.policies.length === 0 ? (
        <SettingsRow label="No decisions logged yet" />
      ) : (
        data.policies.map((p) => (
          <View key={p.policy}>
            <PolicyRow stats={p} theme={theme} />
            <SavingsRows stats={p} />
          </View>
        ))
      )}
      {data?.ok === true ? (
        <SettingsAction
          label="Raw report"
          hint="The gateway's JSON, for sharing or a bug report."
          actionLabel="Copy"
          onPress={() => {
            copyText(data.text).then(
              () => toast.show('Copied', { variant: 'success' }),
              () => toast.error('Copy is not available here'),
            );
          }}
        />
      ) : null}
    </SettingsCard>
  );
}

/**
 * `GET /v1/stats` through the daemon: per-policy volume, latency and agreement with the answers
 * reported back (feedback buttons, human permission answers).
 */
export function StatsSection({ theme }: { theme: Theme }): ReactNode {
  const stats = useRpc(statsRpc);
  const query = useQuery({
    queryKey: useQueryKey('stats'),
    queryFn: async () => stats({}),
    retry: false,
    staleTime: 30_000,
  });
  return (
    <SettingsSection
      title="Shadow statistics"
      info="Agreement compares each decision with the answer reported back: your feedback in chat rows and your answers to permission prompts. Savings count the tokens of agents routing sent (or would send) to another model; dollars appear when the gateway config has a `pricing` table. The same report is available as `local-decider stats`."
      trailing={
        <Button
          theme={theme}
          variant="secondary"
          label={query.isFetching ? 'Loading…' : 'Reload'}
          disabled={query.isFetching}
          onPress={() => void query.refetch()}
        />
      }
    >
      <StatsCard query={query} theme={theme} />
    </SettingsSection>
  );
}

export function StatsScreen({ theme, layout }: PluginScreenProps): ReactNode {
  return (
    <Page theme={theme} compact={layout.compact}>
      <StatsSection theme={theme} />
    </Page>
  );
}
