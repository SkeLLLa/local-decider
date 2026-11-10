import type { PluginScreenProps, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import {
  Loading,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { HOOK_POLICIES, PLUGIN_MODES } from '../shared/constants.ts';
import { policyModeRpc } from '../shared/rpc.ts';
import { deciderSettings } from '../shared/settings.ts';
import { normaliseBaseUrl } from '../shared/url.ts';
import { StatusSection } from './engine-state.tsx';
import { choices, type Save, type SectionProps } from './settings-common.ts';
import { RowsSection, SidebarSection } from './settings-display.tsx';
import { EngineSection } from './settings-engines.tsx';
import { PathsSection } from './settings-paths.tsx';
import { RoutingSection } from './settings-routing.tsx';
import { Page, type Theme } from './ui.tsx';

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
  const setGatewayMode = useRpc(policyModeRpc);
  return (
    <SettingsSection
      title="Policies"
      info="Shadow records what would have happened. Act lets the decider change Paseo's behaviour. Choosing a mode here sets it in the gateway too."
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
            onValueChange={(mode) => {
              save({ ...values, modes: { ...values.modes, [policy]: mode } });
              // The gateway's own mode decides whether a decision is enforced: keep both in step.
              void setGatewayMode({ policy, mode });
            }}
          />
        ))}
        <SettingsSwitch
          label="Add the decide MCP tool to agents"
          hint="Injects <gateway>/mcp into every agent session. Providers without MCP support then fail to open; leave off unless you need it."
          value={values.injectMcp}
          onValueChange={(injectMcp: boolean) => save({ ...values, injectMcp })}
        />
        <SettingsSwitch
          label="Load the model when Paseo starts"
          hint="Off: the gateway loads the model on the first decision (~5 s on FastFlowLM, longer on CPU). On: it is loaded at Paseo start and still unloads after the idle time."
          value={values.preloadOnStart}
          onValueChange={(preloadOnStart: boolean) => save({ ...values, preloadOnStart })}
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

export function SettingsScreen({ theme, navigation }: PluginSurfaceProps): ReactNode {
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
      <StatusSection theme={theme} gatewayUrl={values.gatewayUrl} />
      <GatewaySection values={values} save={save} />
      <EngineSection theme={theme} gatewayUrl={values.gatewayUrl} />
      <PathsSection theme={theme} gatewayUrl={values.gatewayUrl} />
      <PolicySection values={values} save={save} />
      <RowsSection values={values} save={save} />
      <SidebarSection values={values} save={save} />
      <RoutingSection
        theme={theme}
        navigation={navigation}
        gatewayUrl={values.gatewayUrl}
        values={values}
        save={save}
      />
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

/** The settings as a regular plugin screen (opened from the sidebar popover), with scrolling. */
export function SettingsPage(props: PluginScreenProps): ReactNode {
  return (
    <Page theme={props.theme} compact={props.layout.compact}>
      <SettingsScreen {...props} />
    </Page>
  );
}
