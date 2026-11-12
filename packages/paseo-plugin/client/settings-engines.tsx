/**
 * Settings: pick an engine, then a model for it. Rows download models, switch the gateway to one
 * (the gateway persists it) and show an engine's validation result when it has one.
 */
import { openExternalUrl, useRpc } from '@getpaseo/plugin/client';
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
  type EngineCatalog,
  type EngineInfo,
  type EngineModel,
  type Validation,
} from '../shared/engines.ts';
import {
  AUTO_ENGINE,
  LEAVES_AUTO_HINT,
  USE_AUTO_HINT,
  autoHint,
  engineWhere,
  enginesView,
  fallbackLine,
  namesOf,
  runningView,
  suggestionView,
  type EnginesView,
  type RunningView,
  type Suggestion,
} from '../shared/recommendation.ts';
import {
  downloadModelRpc,
  selectEngineRpc,
  selectionModeRpc,
  validateEngineRpc,
} from '../shared/rpc.ts';
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

function EnginesCard({ view }: { view: EnginesView }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <SettingsCard>
      <SettingsAction
        label="Engines on this computer"
        hint={view.summary}
        actionLabel={open ? 'Hide' : 'Show'}
        onPress={() => setOpen(!open)}
      />
      {open
        ? view.rows.map((row) => <SettingsRow key={row.key} label={row.label} hint={row.detail} />)
        : null}
    </SettingsCard>
  );
}

function SuggestionRow({
  theme,
  suggestion,
  action,
  onSwitch,
}: {
  theme: Theme;
  suggestion: Suggestion;
  action: Action;
  onSwitch: (target: SwitchTarget) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  if (suggestion.kind === 'switch') {
    return (
      <SettingsAction
        label="Faster engine available"
        hint={suggestion.hint}
        actionLabel={action.busy === null ? 'Switch' : 'Working…'}
        disabled={action.busy !== null}
        onPress={() => onSwitch(suggestion.target)}
      />
    );
  }
  return (
    <>
      <SettingsAction
        label="Faster engine available"
        hint={suggestion.hint}
        actionLabel={open ? 'Hide' : 'How to install'}
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
          <Mono theme={theme} lines={0}>
            {suggestion.command}
          </Mono>
        </View>
      ) : null}
    </>
  );
}

type SwitchTarget = { engine: string; model: string; device: string | null };

function RunningRow({ theme, view }: { theme: Theme; view: RunningView }): ReactNode {
  return (
    <SettingsRow label="Running" {...(view.hint === '' ? {} : { hint: view.hint })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Value theme={theme}>{view.value}</Value>
        {view.state === null ? null : (
          <Badge theme={theme} tone={view.state.tone} text={view.state.text} />
        )}
      </View>
    </SettingsRow>
  );
}

function RunningCard({ theme, catalog }: { theme: Theme; catalog: EngineCatalog }): ReactNode {
  const select = useRpc(selectEngineRpc);
  const action = useAction();
  const { active } = catalog;
  const names = namesOf(catalog);
  const running = runningView(active, names);
  const fallback = fallbackLine(active, names);
  const suggestion = suggestionView(active, catalog.recommendation, names);
  if (running === null) {
    return null;
  }
  const switchTo = (target: SwitchTarget): void => {
    void action.run('suggestion', async () =>
      outcomeOf(
        await select({ ...target, device: target.device ?? 'auto' }),
        'Switching engines. Decisions fail open until it is ready.',
      ),
    );
  };
  return (
    <SettingsCard>
      <RunningRow theme={theme} view={running} />
      {fallback === null ? null : (
        <SettingsRow label="Using a backup engine" hint={fallback}>
          <Badge theme={theme} tone="warning" text="Backup" />
        </SettingsRow>
      )}
      {suggestion === null ? null : (
        <SuggestionRow theme={theme} suggestion={suggestion} action={action} onSwitch={switchTo} />
      )}
      {action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </SettingsCard>
  );
}

function pickerHint(catalog: EngineCatalog, id: string | null, engine: EngineInfo | null): string {
  const { active, recommendation } = catalog;
  const auto = active?.selectionMode === 'auto';
  if (id === AUTO_ENGINE) {
    return auto ? autoHint(active, namesOf(catalog)) : USE_AUTO_HINT;
  }
  if (auto) {
    return LEAVES_AUTO_HINT;
  }
  return engineHint(
    engine,
    engine === null ? null : engineWhere(engine.id, active, recommendation),
  );
}

function UseAutomatic({ theme }: { theme: Theme }): ReactNode {
  const setMode = useRpc(selectionModeRpc);
  const action = useAction();
  return (
    <>
      <SettingsAction
        label="Automatic selection"
        hint="The gateway chooses the engine and switches if it fails."
        actionLabel={action.busy === null ? 'Use automatic' : 'Working…'}
        disabled={action.busy !== null}
        onPress={() =>
          void action.run('mode', async () =>
            outcomeOf(await setMode({ mode: 'auto' }), 'Automatic selection is on.'),
          )
        }
      />
      {action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </>
  );
}

/** A missing engine the user installs themselves: a link to its install page, nothing run here. */
function InstallRow({ engine }: { engine: EngineInfo | null }): ReactNode {
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

function EngineCard({
  theme,
  catalog,
  id,
  engine,
  device,
  onEngine,
  onDevice,
}: {
  theme: Theme;
  catalog: EngineCatalog;
  id: string | null;
  engine: EngineInfo | null;
  device: string;
  onEngine: (next: string) => void;
  onDevice: (next: string) => void;
}): ReactNode {
  const { active } = catalog;
  const hasMode = active?.selectionMode != null;
  return (
    <SettingsCard>
      <SettingsSelect
        label="Engine"
        hint={pickerHint(catalog, id, engine)}
        value={id ?? ''}
        options={engineOptions(catalog.engines, active?.engine ?? null, hasMode)}
        disabled={catalog.engines.length === 0}
        onValueChange={onEngine}
      />
      <InstallRow engine={engine} />
      {id === AUTO_ENGINE && active?.selectionMode === 'manual' ? (
        <UseAutomatic theme={theme} />
      ) : null}
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
          onValueChange={onDevice}
        />
      )}
    </SettingsCard>
  );
}

function EnginePicker({ theme, catalog }: { theme: Theme; catalog: EngineCatalog }): ReactNode {
  const action = useAction();
  const [picked, setPicked] = useState<string | null>(null);
  const [device, setDevice] = useState('auto');
  const [seed, setSeed] = useState<Seed | null>(null);
  const id = picked ?? initialEngine(catalog);
  const engines = enginesView(catalog.recommendation, namesOf(catalog));
  const engine = catalog.engines.find((e) => e.id === id) ?? null;
  return (
    <>
      <EngineCard
        theme={theme}
        catalog={catalog}
        id={id}
        engine={engine}
        device={device}
        onEngine={(next) => {
          setPicked(next);
          setDevice('auto');
          action.clear();
        }}
        onDevice={setDevice}
      />
      <RunningCard theme={theme} catalog={catalog} />
      {engines === null ? null : <EnginesCard view={engines} />}
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
      info="Automatic picks the fastest engine this computer supports and switches to the next one if it fails. Manual keeps the engine you choose and never changes it on its own."
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
