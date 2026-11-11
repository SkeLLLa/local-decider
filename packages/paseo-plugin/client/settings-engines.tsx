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

import type { DiscoveredServer, Seed } from '../shared/connection.ts';
import {
  deviceOptions,
  engineHint,
  engineOptions,
  initialEngine,
  modelRowState,
  modelRowView,
  type ActiveEngine,
  type EngineCatalog,
  type EngineInfo,
  type EngineModel,
  type Validation,
} from '../shared/engines.ts';
import {
  fallbackText,
  recommendationView,
  selectionModeLabel,
  type CandidateView,
} from '../shared/recommendation.ts';
import { downloadModelRpc, selectEngineRpc, validateEngineRpc } from '../shared/rpc.ts';
import { ConnectionForm } from './connection-form.tsx';
import { type Outcome, outcomeOf, useAction, useEngines } from './hooks.ts';
import { Badge, InlineMessage, Mono, Progress, type Theme, Value } from './ui.tsx';

type Action = ReturnType<typeof useAction>;

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

function ConnectionSlot({
  theme,
  engine,
  seed,
  onSetupLmStudio,
}: {
  theme: Theme;
  engine: EngineInfo | null;
  seed: Seed | null;
  onSetupLmStudio: (server: DiscoveredServer) => void;
}): ReactNode {
  if (engine?.connectable !== true) {
    return null;
  }
  const own = engine.id === 'lmstudio' ? seed : null;
  return (
    <ConnectionForm
      key={`${engine.id}:${own?.url ?? ''}`}
      theme={theme}
      engine={engine}
      seed={own}
      onSetupLmStudio={onSetupLmStudio}
    />
  );
}

function CandidateRow({ theme, view }: { theme: Theme; view: CandidateView }): ReactNode {
  return (
    <SettingsRow label={view.label} hint={view.reason}>
      <Badge theme={theme} tone={view.status === 'Ready' ? 'success' : 'info'} text={view.status} />
    </SettingsRow>
  );
}

function CandidateList({
  theme,
  candidates,
}: {
  theme: Theme;
  candidates: readonly CandidateView[];
}): ReactNode {
  const [all, setAll] = useState(false);
  const shown = all ? candidates : candidates.filter((c) => c.eligible);
  const hidden = candidates.length - candidates.filter((c) => c.eligible).length;
  return (
    <SettingsCard>
      {shown.map((c) => (
        <CandidateRow key={c.key} theme={theme} view={c} />
      ))}
      {hidden === 0 ? null : (
        <SettingsAction
          label={all ? 'Not eligible' : `${String(hidden)} not eligible`}
          hint="Engines the gateway will not pick on its own."
          actionLabel={all ? 'Hide' : 'Show all'}
          onPress={() => setAll(!all)}
        />
      )}
    </SettingsCard>
  );
}

function SelectionRows({
  theme,
  active,
}: {
  theme: Theme;
  active: ActiveEngine | null;
}): ReactNode {
  const mode = selectionModeLabel(active?.selectionMode ?? null);
  const fallback = fallbackText(active?.fallback ?? null);
  return (
    <>
      {mode === null ? null : (
        <SettingsRow
          label="Selection"
          hint={
            active?.selectionMode === 'auto'
              ? 'The gateway picks the best installed engine and falls back if it fails.'
              : 'You chose this engine; the gateway never switches it on its own.'
          }
        >
          <Badge theme={theme} tone="info" text={mode} />
        </SettingsRow>
      )}
      {fallback === null ? null : (
        <SettingsRow label="Fallback" hint={fallback}>
          <Badge theme={theme} tone="error" text="fallback" />
        </SettingsRow>
      )}
    </>
  );
}

function ChoiceCard({ theme, catalog }: { theme: Theme; catalog: EngineCatalog }): ReactNode {
  const { active } = catalog;
  const labels = new Map(catalog.engines.map((e) => [e.id, e.label]));
  const view = recommendationView(catalog.recommendation, active?.selectionMode ?? null, labels);
  if (active?.selectionMode == null && active?.fallback == null && view === null) {
    return null;
  }
  return (
    <>
      <SettingsCard>
        <SelectionRows theme={theme} active={active} />
        {view === null ? null : (
          <SettingsRow label={view.summary.label} hint={view.summary.reason}>
            <Value theme={theme}>{view.summary.value}</Value>
          </SettingsRow>
        )}
      </SettingsCard>
      {view === null || view.candidates.length === 0 ? null : (
        <CandidateList theme={theme} candidates={view.candidates} />
      )}
    </>
  );
}

function EnginePicker({ theme, catalog }: { theme: Theme; catalog: EngineCatalog }): ReactNode {
  const action = useAction();
  const [picked, setPicked] = useState<string | null>(null);
  const [device, setDevice] = useState('auto');
  const [seed, setSeed] = useState<Seed | null>(null);
  const id = picked ?? initialEngine(catalog);
  const engine = catalog.engines.find((e) => e.id === id) ?? null;
  return (
    <>
      <ChoiceCard theme={theme} catalog={catalog} />
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
      <ConnectionSlot
        theme={theme}
        engine={engine}
        seed={seed}
        onSetupLmStudio={(server: DiscoveredServer) => {
          setSeed({ url: server.url, models: server.models });
          setPicked('lmstudio');
          setDevice('auto');
          action.clear();
        }}
      />
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
