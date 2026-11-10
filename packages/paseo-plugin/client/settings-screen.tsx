import type { PluginSurfaceProps } from '@getpaseo/plugin/client';
import { usePaseo, useSettings } from '@getpaseo/plugin/client';
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from '@getpaseo/plugin/client/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import {
  HOOK_POLICIES,
  PLUGIN_MODES,
  ROUTING_PRESETS,
  type RoutingPreset,
} from '../shared/constants.ts';
import { parsePresetModel, presetModelOptions, withCurrent } from '../shared/presets.ts';
import { deciderSettings, type DeciderSettings } from '../shared/settings.ts';
import { normaliseBaseUrl } from '../shared/url.ts';
import { choices, type Save, type SectionProps } from './settings-common.ts';
import { RowsSection, SidebarSection } from './settings-display.tsx';
import { ModelSection, StatusSection } from './settings-model.tsx';
import type { Theme } from './ui.tsx';

const PROVIDER_MODELS_KEY = ['local-decider', 'provider-models'] as const;

/** Models of every available provider, for the routing preset selects. */
function useProviderModels(): ReturnType<typeof useQuery<Awaited<ReturnType<typeof loadModels>>>> {
  const paseo = usePaseo();
  return useQuery({
    queryKey: PROVIDER_MODELS_KEY,
    queryFn: async () => loadModels(paseo),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

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

function GatewaySection({ values, save }: SectionProps): ReactNode {
  const [draft, setDraft] = useState(values.gatewayUrl);
  const normalised = normaliseBaseUrl(draft);
  return (
    <SettingsSection title="Gateway">
      <SettingsCard>
        <SettingsInput
          label="Gateway URL"
          hint="Reached from the daemon. Default http://127.0.0.1:8765. A remote gateway's token comes only from LOCAL_DECIDER_TOKEN in the daemon's environment."
          initialValue={values.gatewayUrl}
          placeholder="http://127.0.0.1:8765"
          onChangeText={setDraft}
          error={normalised === null ? 'Enter an http(s) URL without credentials or query.' : null}
        />
        <SettingsAction
          label="Apply URL"
          actionLabel="Save"
          disabled={normalised === null || normalised === values.gatewayUrl}
          onPress={() => {
            if (normalised !== null) {
              save({ ...values, gatewayUrl: normalised });
            }
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function PolicySection({ values, save }: SectionProps): ReactNode {
  return (
    <SettingsSection
      title="Policies"
      info="Shadow records what would have happened. Act changes Paseo's behaviour, and only when the gateway's own policy mode is act too."
    >
      <SettingsCard>
        {HOOK_POLICIES.map((policy) => (
          <SettingsSelect
            key={policy}
            label={policy}
            value={values.modes[policy]}
            options={choices(PLUGIN_MODES, {
              off: 'Off',
              shadow: 'Shadow (record only)',
              act: 'Act (when the gateway does)',
            })}
            onValueChange={(mode) =>
              save({ ...values, modes: { ...values.modes, [policy]: mode } })
            }
          />
        ))}
        <SettingsSwitch
          label="Add the decide MCP tool to agents"
          hint="Injects <gateway>/mcp into every agent session. Providers without MCP support then fail to open; leave off unless you need it."
          value={values.injectMcp}
          onValueChange={(injectMcp: boolean) => save({ ...values, injectMcp })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function PresetRows({
  preset,
  values,
  save,
  modelOptions,
}: {
  preset: RoutingPreset;
  values: DeciderSettings;
  save: Save;
  modelOptions: readonly { label: string; value: string }[];
}): ReactNode {
  const paseo = usePaseo();
  const setting = values.presets[preset];
  const provider = parsePresetModel(setting.model)?.provider ?? null;
  const modes = useQuery({
    queryKey: ['local-decider', 'provider-modes', provider],
    queryFn: async () => (provider === null ? null : paseo.providers.listModes(provider)),
    enabled: provider !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const modeOptions = withCurrent(
    [
      { label: 'Provider default', value: '' },
      ...(modes.data?.modes ?? []).map((m) => ({ label: m.label, value: m.id })),
    ],
    setting.modeId,
  );
  const update = (next: Partial<DeciderSettings['presets'][RoutingPreset]>): void =>
    save({ ...values, presets: { ...values.presets, [preset]: { ...setting, ...next } } });
  return (
    <>
      <SettingsSelect
        label={`route:${preset}`}
        value={setting.model}
        options={withCurrent(modelOptions, setting.model)}
        onValueChange={(model) => update({ model, modeId: '' })}
      />
      {provider === null ? null : (
        <SettingsSelect
          label={`route:${preset} mode`}
          value={setting.modeId}
          options={modeOptions}
          onValueChange={(modeId) => update({ modeId })}
        />
      )}
    </>
  );
}

function RoutingSection({ values, save }: SectionProps): ReactNode {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const models = useProviderModels();
  const [refreshing, setRefreshing] = useState(false);
  const modelOptions = presetModelOptions(models.data ?? []);
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await paseo.providers.refresh();
      await paseo.providers.waitForReady({ timeoutMs: 20_000 });
    } catch {
      // Discovery keeps going in the background; list whatever is there now.
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['local-decider'] });
      setRefreshing(false);
    }
  };
  return (
    <SettingsSection
      title="Routing presets"
      info="When routing is enforced, a new agent's provider and model follow the preset the gateway picks. Unmapped presets change nothing."
    >
      <SettingsCard>
        {ROUTING_PRESETS.map((preset) => (
          <PresetRows
            key={preset}
            preset={preset}
            values={values}
            save={save}
            modelOptions={modelOptions}
          />
        ))}
        <SettingsAction
          label="Provider models"
          {...(models.error === null ? {} : { hint: String(models.error) })}
          actionLabel={refreshing || models.isFetching ? 'Refreshing…' : 'Refresh'}
          disabled={refreshing}
          onPress={() => void refresh()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Message({ theme, text }: { theme: Theme; text: string }): ReactNode {
  return (
    <View style={{ padding: 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted }}>{text}</Text>
    </View>
  );
}

export function SettingsScreen({ theme }: PluginSurfaceProps): ReactNode {
  const settings = useSettings(deciderSettings);
  if (settings.status === 'loading') {
    return <Loading />;
  }
  if (settings.status === 'error') {
    return <Message theme={theme} text={`Settings unavailable: ${settings.error}`} />;
  }
  if (settings.status === 'invalid') {
    return (
      <SettingsSection title="Settings">
        <SettingsAction
          label="Stored settings are invalid"
          hint={settings.error}
          actionLabel="Reset to defaults"
          onPress={() => void settings.reset()}
        />
      </SettingsSection>
    );
  }
  const { values, revision } = settings;
  const save: Save = (next) => {
    void settings.save(next, revision);
  };
  return (
    <View style={{ gap: 16 }}>
      {settings.saveError === null ? null : <Message theme={theme} text={settings.saveError} />}
      <StatusSection />
      <GatewaySection values={values} save={save} />
      <ModelSection values={values} save={save} />
      <PolicySection values={values} save={save} />
      <RowsSection values={values} save={save} />
      <SidebarSection values={values} save={save} />
      <RoutingSection values={values} save={save} />
      <SettingsSection title="Reset">
        <SettingsCard>
          <SettingsAction
            label="Restore defaults"
            hint="Every setting on this page, on this host. The gateway keeps its own config.yaml and logs."
            actionLabel="Reset"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
