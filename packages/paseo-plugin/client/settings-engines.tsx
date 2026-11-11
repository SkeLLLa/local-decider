/**
 * Settings: pick an engine, then a model for it. Rows download models, switch the gateway to one
 * (the gateway persists it) and show an engine's validation result when it has one.
 */
import { useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import {
  deviceOptions,
  engineOptions,
  initialEngine,
  modelRowState,
  modelRowView,
  type EngineCatalog,
  type EngineInfo,
  type EngineModel,
  type Validation,
} from '../shared/engines.ts';
import { downloadModelRpc, selectEngineRpc, validateEngineRpc } from '../shared/rpc.ts';
import { type Outcome, outcomeOf, useAction, useEngines } from './hooks.ts';
import { Badge, InlineMessage, Mono, Progress, type Theme, Value } from './ui.tsx';

type Action = ReturnType<typeof useAction>;

function engineHint(engine: EngineInfo | null): string {
  if (engine === null) {
    return 'The gateway lists no engines.';
  }
  const detail = engine.detail ?? '';
  const note = engine.supported ? '' : (engine.unsupportedReason ?? 'Not supported here.');
  let state = detail;
  if (!engine.available) {
    state = engine.installed ? `Unavailable here. ${detail}` : `Not installed. ${detail}`;
  }
  return [engine.description, note, state].filter((p) => p !== '').join(' ');
}

interface RowProps {
  readonly theme: Theme;
  readonly model: EngineModel;
  readonly catalog: EngineCatalog;
  readonly engine: EngineInfo;
  readonly device: string;
  readonly action: Action;
}

function ModelRow({ theme, model, catalog, engine, device, action }: RowProps): ReactNode {
  const select = useRpc(selectEngineRpc);
  const download = useRpc(downloadModelRpc);
  const state = modelRowState(model, {
    active: catalog.active,
    downloads: catalog.downloads,
    engineAvailable: engine.available,
    device,
  });
  const view = modelRowView(model, state, { device, totalMemoryGb: catalog.totalMemoryGb });
  if (state.kind === 'downloading') {
    const pct =
      state.progress === null ? 'Downloading…' : `${String(Math.round(state.progress * 100))}%`;
    return (
      <SettingsRow label={view.label} hint={view.hint}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Progress theme={theme} value={state.progress} />
          <Value theme={theme} muted>
            {pct}
          </Value>
        </View>
      </SettingsRow>
    );
  }
  const press = (): void => {
    const target = { engine: model.engine, model: model.id };
    if (view.action === 'download') {
      void action.run(`download:${model.id}`, async () =>
        outcomeOf(await download(target), `Downloading ${model.label}.`),
      );
    } else if (view.action === 'use') {
      void action.run(`use:${model.id}`, async () =>
        outcomeOf(
          await select({ ...target, device: engine.devices.length > 0 ? device : 'auto' }),
          `Switching to ${model.label}. Decisions fail open until it is ready.`,
        ),
      );
    }
  };
  const mine = action.busy?.endsWith(`:${model.id}`) === true;
  return (
    <SettingsAction
      label={view.label}
      hint={view.hint}
      actionLabel={mine ? 'Working…' : view.actionLabel}
      disabled={view.action === null || action.busy !== null}
      onPress={press}
    />
  );
}

function validationOutcome(res: {
  ok: boolean;
  error: string | null;
  validation: Validation | null;
}): Outcome {
  if (!res.ok) {
    return outcomeOf(res, '');
  }
  const v = res.validation;
  return v === null || v.ok
    ? { tone: 'success', text: v?.summary ?? 'Validation passed.' }
    : { tone: 'error', text: `Validation failed: ${v.summary ?? 'see the output'}` };
}

function ValidationOutput({ theme, lines }: { theme: Theme; lines: string[] }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsAction
        label="Output"
        hint={`${String(lines.length)} lines`}
        actionLabel={open ? 'Hide' : 'Show'}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          <Mono theme={theme} lines={0}>
            {lines.join('\n')}
          </Mono>
        </View>
      ) : null}
    </>
  );
}

function ValidationResult({
  theme,
  label,
  validation: v,
}: {
  theme: Theme;
  label: string;
  validation: Validation | null;
}): ReactNode {
  const lines = v?.lines ?? [];
  const checkedAt = v?.checkedAt ?? null;
  return (
    <>
      <SettingsRow
        label={`${label} validation`}
        hint={v === null ? 'Not checked yet.' : (v.summary ?? '')}
      >
        {v === null ? null : (
          <Badge theme={theme} tone={v.ok ? 'success' : 'error'} text={v.ok ? 'ok' : 'failed'} />
        )}
      </SettingsRow>
      {checkedAt === null ? null : (
        <SettingsRow label="Checked">
          <Value theme={theme} muted>
            {new Date(checkedAt).toLocaleString()}
          </Value>
        </SettingsRow>
      )}
      {lines.length === 0 ? null : <ValidationOutput theme={theme} lines={lines} />}
    </>
  );
}

function ValidationCard({ theme, engine }: { theme: Theme; engine: EngineInfo }): ReactNode {
  const validate = useRpc(validateEngineRpc);
  const action = useAction();
  const v = engine.validation;
  return (
    <SettingsCard>
      <ValidationResult theme={theme} label={engine.label} validation={v} />
      <SettingsAction
        label={`Check ${engine.label}`}
        hint="Runs the engine's own check on the gateway machine; takes a few seconds."
        actionLabel={action.busy === null ? 'Re-validate' : 'Checking…'}
        disabled={action.busy !== null}
        onPress={() =>
          void action.run('validate', async () =>
            validationOutcome(await validate({ engine: engine.id })),
          )
        }
      />
      {action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </SettingsCard>
  );
}

function ModelList(props: Omit<RowProps, 'model'>): ReactNode {
  const models = props.catalog.models.filter((m) => m.engine === props.engine.id);
  return (
    <SettingsCard>
      {models.length === 0 ? (
        <SettingsRow label="No models" hint="The gateway lists no models for this engine." />
      ) : (
        models.map((model) => <ModelRow key={model.id} {...props} model={model} />)
      )}
      {props.action.outcome === null ? null : (
        <InlineMessage
          theme={props.theme}
          tone={props.action.outcome.tone}
          text={props.action.outcome.text}
        />
      )}
    </SettingsCard>
  );
}

function EnginePicker({ theme, catalog }: { theme: Theme; catalog: EngineCatalog }): ReactNode {
  const action = useAction();
  const [picked, setPicked] = useState<string | null>(null);
  const [device, setDevice] = useState('auto');
  const id = picked ?? initialEngine(catalog);
  const engine = catalog.engines.find((e) => e.id === id) ?? null;
  return (
    <>
      <SettingsCard>
        <SettingsSelect
          label="Engine"
          hint={engineHint(engine)}
          value={id ?? ''}
          options={engineOptions(catalog.engines, catalog.active?.engine ?? null)}
          disabled={catalog.engines.length === 0}
          onValueChange={(next) => {
            setPicked(next);
            setDevice('auto');
            action.clear();
          }}
        />
        {engine === null || engine.calibrated ? null : (
          <SettingsRow
            label="Calibration"
            hint="This engine's confidence is not calibrated against the policy thresholds."
          >
            <Badge theme={theme} tone="info" text="uncalibrated" />
          </SettingsRow>
        )}
        {engine === null || engine.devices.length === 0 ? null : (
          <SettingsSelect
            label="Device"
            hint="Used when you press Use. Gateway default keeps the gateway's device."
            value={device}
            options={deviceOptions(engine.devices)}
            onValueChange={setDevice}
          />
        )}
      </SettingsCard>
      {engine === null ? null : (
        <ModelList
          theme={theme}
          catalog={catalog}
          engine={engine}
          device={device}
          action={action}
        />
      )}
      {engine?.capabilities.validate === true ? (
        <ValidationCard theme={theme} engine={engine} />
      ) : null}
    </>
  );
}

export function EngineSection({
  theme,
  gatewayUrl,
}: {
  theme: Theme;
  gatewayUrl: string;
}): ReactNode {
  const { data, isFetching, refetch } = useEngines(gatewayUrl);
  const reachable = data?.reachable === true;
  return (
    <SettingsSection
      title="Engine and model"
      info="Pick an engine to see its models. Use switches the gateway now, and the gateway keeps the choice across restarts. Decisions fail open while a model loads."
    >
      {reachable ? (
        <EnginePicker theme={theme} catalog={data} />
      ) : (
        <SettingsCard>
          <SettingsAction
            label={data === undefined ? 'Checking…' : 'Engines unavailable'}
            hint={
              data === undefined
                ? 'Asking the gateway for its engines.'
                : 'The gateway is unreachable or has no /v1/engines.'
            }
            actionLabel={isFetching ? 'Checking…' : 'Refresh'}
            disabled={isFetching}
            onPress={() => void refetch()}
          />
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
