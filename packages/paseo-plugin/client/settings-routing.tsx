/**
 * Settings: which routing policy the gateway runs (a shipped variant or the user's own), and the
 * provider/model each of its presets maps to. Both live in the gateway's config.yaml, shared with
 * Claude Code and Codex; this host's old preset map is moved there once.
 */
import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from '@getpaseo/plugin/client/ui';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  legacyPresetMoves,
  presetRows,
  type PolicyVariants,
  type RoutingSettings,
} from '../shared/policies.ts';
import { modelThinking, presetModelOptions } from '../shared/presets.ts';
import {
  policyVariantRpc,
  policyVariantsRpc,
  reloadPoliciesRpc,
  routingPresetRpc,
  routingSettingsRpc,
} from '../shared/rpc.ts';
import { outcomeOf, useAction } from './hooks.ts';
import { useQueryKey } from './host-scope.ts';
import { PresetTable } from './preset-table.tsx';
import type { SectionProps } from './settings-common.ts';
import { InlineMessage, Mono, type Theme } from './ui.tsx';
import { WritePolicyRows } from './write-policy.tsx';

const ROUTING_POLICY = 'routing';
/** Prints the same prompt for any AI assistant in a terminal. */
const PROMPT_COMMAND = `local-decider policies prompt ${ROUTING_POLICY}`;

type Paseo = ReturnType<typeof usePaseo>;
type ProviderModels = Awaited<ReturnType<Paseo['providers']['listModels']>>;

async function loadModels(paseo: Paseo): Promise<ProviderModels[]> {
  const available = await paseo.providers.listAvailable();
  const providers = available.providers.filter((p) => p.available).map((p) => p.provider);
  const results = await Promise.all(
    providers.map(async (provider) => paseo.providers.listModels(provider).catch(() => null)),
  );
  return results.filter((r) => r !== null);
}

/** Models of every available provider, for the preset selects. */
function useProviderModels(): UseQueryResult<ProviderModels[]> {
  const paseo = usePaseo();
  return useQuery({
    queryKey: useQueryKey('provider-models'),
    queryFn: async () => loadModels(paseo),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

function useRoutingVariants(gatewayUrl: string): UseQueryResult<PolicyVariants> {
  const variants = useRpc(policyVariantsRpc);
  return useQuery({
    queryKey: useQueryKey('policy-variants', ROUTING_POLICY, gatewayUrl),
    queryFn: async () => variants({ policy: ROUTING_POLICY }),
    retry: false,
    staleTime: 10_000,
  });
}

function useRoutingSettings(gatewayUrl: string): UseQueryResult<RoutingSettings> {
  const settings = useRpc(routingSettingsRpc);
  return useQuery({
    queryKey: useQueryKey('routing-settings', gatewayUrl),
    queryFn: async () => settings({}),
    retry: false,
    staleTime: 10_000,
  });
}

/** Move presets mapped in this host's plugin settings into config.yaml, once per screen. */
function useLegacyPresetMove(
  { values, save }: SectionProps,
  routing: RoutingSettings | undefined,
): void {
  const setPreset = useRpc(routingPresetRpc);
  const queryClient = useQueryClient();
  const routingKey = useQueryKey('routing-settings');
  const done = useRef(false);
  useEffect(() => {
    if (done.current || routing?.ok !== true || Object.keys(values.presets).length === 0) {
      return;
    }
    done.current = true;
    const moves = legacyPresetMoves(values.presets, routing.presets);
    void Promise.all(moves.map(async (move) => setPreset(move))).then(async (results) => {
      if (results.every((r) => r.ok)) {
        save({ ...values, presets: {} });
      }
      await queryClient.invalidateQueries({ queryKey: routingKey });
    });
  }, [routing, values, save, setPreset, queryClient, routingKey]);
}

/** The variant select, where the settings live, and a reload button. */
function VariantRows({
  theme,
  variants,
  file,
}: {
  theme: Theme;
  variants: PolicyVariants | undefined;
  file: string | null;
}): ReactNode {
  const choose = useRpc(policyVariantRpc);
  const reload = useRpc(reloadPoliciesRpc);
  const action = useAction();
  const active = variants?.variants.find((v) => v.id === variants.active);
  return (
    <>
      {variants === undefined || !variants.ok ? (
        <SettingsRow label="Routing policy" hint={variants?.error ?? 'Asking the gateway…'} />
      ) : (
        <SettingsSelect
          label="Routing policy"
          hint={active?.description ?? ''}
          value={variants.active ?? ROUTING_POLICY}
          options={variants.variants.map((v) => ({
            label: v.id === ROUTING_POLICY ? `${v.id} (default)` : v.id,
            value: v.id,
          }))}
          onValueChange={(variant) =>
            void action.run('variant', async () =>
              outcomeOf(
                await choose({ policy: ROUTING_POLICY, variant }),
                `Routing now uses ${variant}.`,
              ),
            )
          }
        />
      )}
      <SettingsAction
        label="Policy files"
        hint="Re-read the gateway's policies after adding or editing one in its config directory (usually ~/.config/local-decider/policies)."
        actionLabel={action.busy === 'reload' ? 'Reloading…' : 'Reload'}
        disabled={action.busy !== null}
        onPress={() =>
          void action.run('reload', async () => {
            const res = await reload({});
            return outcomeOf(res, `Loaded ${String(res.count)} policies.`);
          })
        }
      />
      <SettingsRow
        label="Settings file"
        hint={`Routing policy, presets for Paseo, Claude Code and Codex, and policy modes. Agents can edit it (it has a JSON Schema); the gateway applies changes as they happen. In a terminal, ${PROMPT_COMMAND} prints the policy-writing prompt for any assistant.`}
      >
        {file === null ? null : <Mono theme={theme}>{file}</Mono>}
      </SettingsRow>
      {action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </>
  );
}

/** "Refresh" for provider model lists: rediscover providers, then re-query everything. */
function ProviderModelsRow({ models }: { models: UseQueryResult<ProviderModels[]> }): ReactNode {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const hostKey = useQueryKey();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await paseo.providers.refresh();
      await paseo.providers.waitForReady({ timeoutMs: 20_000 });
    } catch {
      // Discovery keeps going in the background; list whatever is there now.
    } finally {
      await queryClient.invalidateQueries({ queryKey: hostKey });
      setRefreshing(false);
    }
  };
  return (
    <SettingsAction
      label="Provider models"
      {...(models.error === null ? {} : { hint: String(models.error) })}
      actionLabel={refreshing || models.isFetching ? 'Refreshing…' : 'Refresh'}
      disabled={refreshing}
      onPress={() => void refresh()}
    />
  );
}

export function RoutingSection({
  theme,
  navigation,
  gatewayUrl,
  values,
  save,
}: SectionProps & {
  theme: Theme;
  navigation: PluginSurfaceProps['navigation'];
  gatewayUrl: string;
}): ReactNode {
  const models = useProviderModels();
  const variants = useRoutingVariants(gatewayUrl);
  const routing = useRoutingSettings(gatewayUrl);
  useLegacyPresetMove({ values, save }, routing.data);
  const presets = routing.data?.presets ?? {};
  const modelOptions = presetModelOptions(models.data ?? []);
  const routes = variants.data?.variants.find((v) => v.id === variants.data.active)?.routes ?? [];
  const routingError = routing.data?.ok === false ? routing.data.error : null;
  return (
    <SettingsSection
      title="Routing"
      info="When routing is enforced, a new agent's provider and model follow the preset the routing policy picks. Unmapped presets change nothing."
    >
      <SettingsCard>
        <VariantRows theme={theme} variants={variants.data} file={routing.data?.file ?? null} />
        {routingError === null ? null : (
          <InlineMessage theme={theme} tone="error" text={routingError} />
        )}
        <PresetTable
          theme={theme}
          rows={presetRows(routes, presets)}
          presets={presets}
          models={modelOptions}
          thinking={modelThinking(models.data ?? [])}
        />
        <WritePolicyRows theme={theme} navigation={navigation} modelOptions={modelOptions} />
        <ProviderModelsRow models={models} />
      </SettingsCard>
    </SettingsSection>
  );
}
