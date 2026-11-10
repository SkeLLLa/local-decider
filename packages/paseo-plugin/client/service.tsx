/**
 * Start, stop and restart the gateway's user service. The daemon runs a fixed command per
 * platform (server/service.ts); each button shows exactly which. Stop asks first, inline.
 */
import { useRpc } from '@getpaseo/plugin/client';
import {
  copyText,
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  useToast,
} from '@getpaseo/plugin/client/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { INSTALL_SERVICE_COMMAND, type ServiceAction } from '../shared/constants.ts';
import { serviceRpc } from '../shared/rpc.ts';
import { type Outcome, useAction, useServiceInfo } from './hooks.ts';
import { Button, InlineMessage, Mono, type Theme } from './ui.tsx';

const LABELS: Record<ServiceAction, string> = {
  start: 'Start gateway',
  stop: 'Stop gateway',
  restart: 'Restart gateway',
};

const DONE: Record<ServiceAction, string> = {
  start: 'Gateway started.',
  stop: 'Gateway stopped.',
  restart: 'Gateway restarted.',
};

function serviceOutcome(
  action: ServiceAction,
  res: { ok: boolean; output: string; error: string | null },
): Outcome {
  const output = res.output === '' ? '' : ` ${res.output}`;
  return res.ok
    ? { tone: 'success', text: `${DONE[action]}${output}` }
    : {
        tone: 'error',
        text: `${LABELS[action]} failed: ${res.error ?? 'unknown error'}.${output}`,
      };
}

/** Run a service action daemon-side; the outcome stays for an inline message. */
export function useServiceRun(): ReturnType<typeof useAction> & {
  start: (action: ServiceAction) => Promise<Outcome>;
} {
  const service = useRpc(serviceRpc);
  const action = useAction();
  return {
    ...action,
    start: async (name) =>
      action.run(name, async () => serviceOutcome(name, await service({ action: name }))),
  };
}

function ServiceRow({
  theme,
  action,
  command,
  busy,
  onPress,
}: {
  theme: Theme;
  action: ServiceAction;
  command: string;
  busy: string | null;
  onPress: () => void;
}): ReactNode {
  return (
    <View>
      <SettingsRow label={LABELS[action]}>
        <Button
          theme={theme}
          variant={action === 'start' ? 'primary' : 'secondary'}
          label={busy === action ? 'Running…' : (LABELS[action].split(' ')[0] ?? action)}
          disabled={busy !== null}
          onPress={onPress}
        />
      </SettingsRow>
      <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
        <Mono theme={theme}>{`Runs: ${command}`}</Mono>
      </View>
    </View>
  );
}

/** Inline confirmation under the buttons: stopping makes every decision fail open. */
function ConfirmStop({
  theme,
  command,
  onCancel,
  onConfirm,
}: {
  theme: Theme;
  command: string;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>
        Stop the gateway? Decisions fail open until it starts again.
      </Text>
      <Mono theme={theme} lines={2}>{`Runs: ${command}`}</Mono>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button theme={theme} variant="secondary" grow label="Cancel" onPress={onCancel} />
        <Button theme={theme} grow label="Stop gateway" onPress={onConfirm} />
      </View>
    </View>
  );
}

function InstallHint(): ReactNode {
  const toast = useToast();
  return (
    <SettingsCard>
      <SettingsAction
        label="No gateway service installed"
        hint={`Install the service: ${INSTALL_SERVICE_COMMAND}`}
        actionLabel="Copy"
        onPress={() => {
          copyText(INSTALL_SERVICE_COMMAND).then(
            () => toast.show('Copied', { variant: 'success' }),
            () => toast.error('Copy is not available here'),
          );
        }}
      />
    </SettingsCard>
  );
}

/** `requested` comes from a Command Center item: start and restart run, stop asks first. */
export function ServiceSection({
  theme,
  requested,
}: {
  theme: Theme;
  requested: { action: ServiceAction; nonce: string } | null;
}): ReactNode {
  const info = useServiceInfo();
  const svc = useServiceRun();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const commands = info.data?.commands ?? null;
  const run = (action: ServiceAction, notify: boolean): void => {
    void svc.start(action).then((outcome) => {
      if (notify) {
        toast.show(outcome.text, { variant: outcome.tone });
      }
      return outcome;
    });
  };
  const ready = commands !== null;
  // Each Command Center request carries a fresh nonce; handle it once.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (requested === null || !ready || handled.current === requested.nonce) {
      return;
    }
    handled.current = requested.nonce;
    if (requested.action === 'stop') {
      setConfirming(true);
    } else {
      run(requested.action, true);
    }
  }, [requested, ready, run]);
  return (
    <SettingsSection
      title="Gateway service"
      info="The plugin runs only these commands, on the daemon machine, through the gateway's user service. Nothing else is ever started."
    >
      {commands === null ? (
        info.data === undefined ? null : (
          <InstallHint />
        )
      ) : (
        <SettingsCard>
          {(['start', 'stop', 'restart'] as const).map((action) => (
            <ServiceRow
              key={action}
              theme={theme}
              action={action}
              command={commands[action]}
              busy={svc.busy}
              onPress={() => (action === 'stop' ? setConfirming(true) : run(action, false))}
            />
          ))}
          {confirming ? (
            <ConfirmStop
              theme={theme}
              command={commands.stop}
              onCancel={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false);
                run('stop', requested?.action === 'stop');
              }}
            />
          ) : null}
          {svc.outcome === null ? null : (
            <InlineMessage theme={theme} tone={svc.outcome.tone} text={svc.outcome.text} />
          )}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
