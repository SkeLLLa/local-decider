/**
 * The engine's load state in plain words, Load now and Unload, and the lifecycle choice: load on
 * demand and unload when idle, or always loaded. Shared by the settings and status screens.
 */
import { useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';

import { engineTag, type ActiveEngine } from '../shared/engines.ts';
import {
  engineStateNote,
  IDLE_MINUTES,
  idleMinutesError,
  lifecycleLabel,
  type LifecycleChoice,
} from '../shared/lifecycle.ts';
import { statusSummary } from '../shared/poll.ts';
import { engineLoadRpc, lifecycleRpc } from '../shared/rpc.ts';
import { outcomeOf, type Status, useAction, useEngines, useGatewayStatus } from './hooks.ts';
import { InlineMessage, type Theme } from './ui.tsx';

type Action = ReturnType<typeof useAction>;

function stateNote(status: Status | undefined, active: ActiveEngine | null): string {
  if (status === undefined) {
    return 'Checking…';
  }
  if (!status.up) {
    return 'The gateway is not running.';
  }
  // Health is the live source; the engines list adds the lifecycle.
  return engineStateNote({
    state: status.engineState,
    detail: status.detail,
    model: status.model,
    engineTag: engineTag(status.engine, status.engineTag),
    lifecycle: active?.lifecycle ?? null,
  });
}

function LoadRows({
  up,
  state,
  action,
}: {
  up: boolean;
  state: string | null;
  action: Action;
}): ReactNode {
  const load = useRpc(engineLoadRpc);
  const idle = action.busy === null;
  return (
    <>
      <SettingsAction
        label="Load now"
        hint="Loads the model now instead of on the next decision."
        actionLabel={action.busy === 'load' ? 'Loading…' : 'Load now'}
        disabled={!up || !idle || state === 'ready' || state === 'starting'}
        onPress={() =>
          void action.run('load', async () =>
            outcomeOf(await load({ action: 'load' }), 'Loading the model.'),
          )
        }
      />
      <SettingsAction
        label="Unload"
        hint="Frees the memory or NPU it holds. Decisions fail open until it loads again."
        actionLabel={action.busy === 'unload' ? 'Unloading…' : 'Unload'}
        disabled={!up || !idle || state === 'stopped'}
        onPress={() =>
          void action.run('unload', async () =>
            outcomeOf(await load({ action: 'unload' }), 'Unloaded.'),
          )
        }
      />
    </>
  );
}

function LifecycleRows({ active, action }: { active: ActiveEngine; action: Action }): ReactNode {
  const setLifecycle = useRpc(lifecycleRpc);
  const minutes = active.idleUnloadMinutes ?? IDLE_MINUTES.fallback;
  const [draft, setDraft] = useState(String(minutes));
  const choice: LifecycleChoice = active.lifecycle ?? 'lazy';
  const draftError = idleMinutesError(draft);
  const apply = (lifecycle: LifecycleChoice, idle: number): void => {
    void action.run('lifecycle', async () =>
      outcomeOf(
        await setLifecycle(
          lifecycle === 'lazy' ? { lifecycle, idleUnloadMinutes: idle } : { lifecycle },
        ),
        lifecycle === 'lazy' ? lifecycleLabel('lazy', idle) : 'Always loaded.',
      ),
    );
  };
  return (
    <>
      <SettingsSelect
        label="Lifecycle"
        value={choice}
        options={[
          { label: lifecycleLabel('lazy', minutes), value: 'lazy' },
          { label: lifecycleLabel('eager', minutes), value: 'eager' },
        ]}
        disabled={action.busy !== null}
        onValueChange={(next) => apply(next, minutes)}
      />
      {choice === 'lazy' ? (
        <>
          <SettingsInput
            key={String(minutes)}
            label="Unload after (minutes idle)"
            initialValue={String(minutes)}
            placeholder={String(IDLE_MINUTES.fallback)}
            onChangeText={setDraft}
            error={draftError}
          />
          <SettingsAction
            label="Apply idle time"
            actionLabel="Save"
            disabled={draftError !== null || Number(draft) === minutes || action.busy !== null}
            onPress={() => apply('lazy', Number(draft.trim()))}
          />
        </>
      ) : null}
    </>
  );
}

export function EngineControls({
  theme,
  gatewayUrl,
}: {
  theme: Theme;
  gatewayUrl: string;
}): ReactNode {
  const status = useGatewayStatus();
  const engines = useEngines(gatewayUrl);
  const action = useAction();
  const active = engines.data?.active ?? null;
  const up = status.data?.up === true;
  const state = status.data?.engineState ?? active?.state ?? null;
  return (
    <SettingsCard>
      <SettingsRow label="Engine" hint={stateNote(status.data, active)} />
      <LoadRows up={up} state={state} action={action} />
      {active?.lifecycle == null ? null : <LifecycleRows active={active} action={action} />}
      {action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </SettingsCard>
  );
}

/** Settings: gateway health, then the engine's state and lifecycle. */
export function StatusSection({
  theme,
  gatewayUrl,
}: {
  theme: Theme;
  gatewayUrl: string;
}): ReactNode {
  const { data, isFetching, refetch } = useGatewayStatus();
  return (
    <SettingsSection title="Status">
      <SettingsCard>
        <SettingsAction
          label={data === undefined ? 'Gateway' : data.up ? 'Gateway is up' : 'Gateway is down'}
          hint={statusSummary(data)}
          actionLabel={isFetching ? 'Checking…' : 'Refresh'}
          disabled={isFetching}
          onPress={() => void refetch()}
        />
      </SettingsCard>
      <EngineControls theme={theme} gatewayUrl={gatewayUrl} />
    </SettingsSection>
  );
}
