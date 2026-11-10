/** Settings: live gateway status and the decision model the gateway serves. */
import { useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from '@getpaseo/plugin/client/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { DEVICES, type Device } from '../shared/constants.ts';
import {
  decisionModelOptions,
  pendingSelection,
  shortModel,
  type EngineSelection,
} from '../shared/models.ts';
import { statusSummary } from '../shared/poll.ts';
import { selectModelRpc } from '../shared/rpc.ts';
import { type Catalog, useGatewayCatalog, useGatewayStatus } from './hooks.ts';
import { choices, type SectionProps } from './settings-common.ts';

export function StatusSection(): ReactNode {
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
    </SettingsSection>
  );
}

function servedText(catalog: Catalog | undefined): string {
  if (catalog === undefined) {
    return 'Checking…';
  }
  if (!catalog.reachable || catalog.active === null) {
    return 'The gateway is unreachable.';
  }
  const device = catalog.device === null ? '' : ` on ${catalog.device}`;
  const fixed = catalog.switchable
    ? ''
    : '. This engine cannot switch at runtime (remote engine or engine.url); set engine.model in config.yaml.';
  return `${shortModel(catalog.active)}${device}${fixed}`;
}

/** Switch the gateway's model, reporting the outcome as a toast. */
function useSwitchModel(): { switching: boolean; apply: (s: EngineSelection) => Promise<void> } {
  const select = useRpc(selectModelRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const apply = async (selection: EngineSelection): Promise<void> => {
    setSwitching(true);
    try {
      const res = await select({ model: selection.model, device: selection.device as Device });
      if (res.ok) {
        toast.show(
          `Loading ${shortModel(selection.model)}. Decisions fail open until it is ready.`,
          {
            variant: 'success',
          },
        );
      } else {
        toast.error(`Model not switched: ${res.error ?? 'unknown error'}`);
      }
    } catch (error) {
      toast.error(`Model not switched: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSwitching(false);
      await queryClient.invalidateQueries({ queryKey: ['local-decider'] });
    }
  };
  return { switching, apply };
}

export function ModelSection({ values, save }: SectionProps): ReactNode {
  const catalog = useGatewayCatalog(values.gatewayUrl);
  const { switching, apply } = useSwitchModel();
  const data = catalog.data;
  const live = { model: data?.active ?? null, device: data?.device ?? null };
  const switchable = data?.switchable === true;
  const pending = pendingSelection(values, live);

  const choose = (next: { model: string; device: Device }): void => {
    save({ ...values, ...next });
    const selection = switchable ? pendingSelection(next, live) : null;
    if (selection !== null) {
      void apply(selection);
    }
  };

  return (
    <SettingsSection
      title="Decision model"
      info="Switching restarts the gateway's engine. A model's first use downloads it (several GB) and decisions fail open until it is ready. The choice lasts until the gateway restarts unless Keep is on; set engine.model in config.yaml to change the default."
    >
      <SettingsCard>
        <SettingsSelect
          label="Model"
          hint="Approximate memory needed is shown next to each model."
          value={values.model}
          options={decisionModelOptions(data ?? { models: [], active: null }, values.model)}
          disabled={switching}
          onValueChange={(model) => choose({ model, device: values.device })}
        />
        <SettingsSelect
          label="Device"
          value={values.device}
          options={choices(DEVICES, {
            auto: 'Gateway default',
            cpu: 'CPU',
            mlx: 'MLX (Apple)',
            mps: 'MPS (Apple)',
            cuda: 'CUDA',
          })}
          disabled={switching || values.model === ''}
          onValueChange={(device) => choose({ model: values.model, device })}
        />
        <SettingsSwitch
          label="Keep after gateway restarts"
          hint="Checks every minute and switches the gateway back to this model."
          value={values.keepModel}
          disabled={values.model === ''}
          onValueChange={(keepModel: boolean) => save({ ...values, keepModel })}
        />
        <SettingsAction
          label="Gateway serves"
          hint={servedText(data)}
          actionLabel={
            switching ? 'Switching…' : pending !== null && switchable ? 'Switch now' : 'Refresh'
          }
          disabled={switching || catalog.isFetching}
          onPress={() => void (pending !== null && switchable ? apply(pending) : catalog.refetch())}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
