/** Where to get a missing engine: the install page and the command, nothing is run here. */
import { openExternalUrl } from '@getpaseo/plugin/client';
import { SettingsAction } from '@getpaseo/plugin/client/ui';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { EngineInfo } from '../shared/engines.ts';
import { installCommand } from '../shared/recommendation.ts';
import { Button, Mono, type Theme } from './ui.tsx';

/** A missing engine the user installs themselves: a link to its install page, nothing run here. */
export function InstallRow({ engine }: { engine: EngineInfo | null }): ReactNode {
  if (engine === null || engine.installed || !engine.supported || engine.installUrl === null) {
    return null;
  }
  const url = engine.installUrl;
  return (
    <SettingsAction
      label={`Install ${engine.label}`}
      hint={engine.detail ?? 'Not installed on the gateway machine.'}
      actionLabel="Install guide"
      onPress={() => void openExternalUrl(url)}
    />
  );
}

/** The install steps of card 1: the engine, its guide, the command, and a way to check again. */
export function InstallSteps({
  theme,
  engine,
  target,
  busy,
  onCheck,
}: {
  theme: Theme;
  engine: EngineInfo | null;
  target: { engine: string; model: string; device: string | null };
  busy: boolean;
  onCheck: () => void;
}): ReactNode {
  const name = engine?.label ?? target.engine;
  const url = engine?.installUrl ?? null;
  const command = installCommand({ ...target, reason: '', explicit: false }, null);
  return (
    <View style={{ gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
        {`1. Install ${name} on the gateway machine.`}
      </Text>
      {url === null ? null : (
        <Button
          theme={theme}
          variant="secondary"
          label="Install guide"
          icon="ExternalLink"
          onPress={() => void openExternalUrl(url)}
        />
      )}
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>2. Then run:</Text>
      <Mono theme={theme} lines={0}>
        {command}
      </Mono>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
        3. Come back and check again.
      </Text>
      <Button
        theme={theme}
        variant="secondary"
        label="Check again"
        disabled={busy}
        onPress={onCheck}
      />
    </View>
  );
}
