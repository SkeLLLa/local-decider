/**
 * Settings: connect an OpenAI-compatible server or LM Studio. URL, model and the name of a token
 * environment variable are saved on the gateway; discovery only fills the form and never selects
 * an engine. Nothing here says "connected" without a reachable probe.
 */
import { useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
} from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';

import {
  buildConnectionPayload,
  initialForm,
  isConnectable,
  lmStudioNote,
  lmStudioSuggestion,
  reachableSuggestions,
  serverSummary,
  type DiscoveredServer,
  type FormValues,
  type Seed,
} from '../shared/connection.ts';
import type { EngineInfo } from '../shared/engines.ts';
import { discoverServersRpc, saveConnectionRpc, selectEngineRpc } from '../shared/rpc.ts';
import { type Outcome, outcomeOf, useAction } from './hooks.ts';
import { InlineMessage, type Theme } from './ui.tsx';

interface Props {
  readonly theme: Theme;
  readonly engine: EngineInfo;
  /** Fill in LM Studio's form from a found server; the picker moves to LM Studio. */
  readonly onSetupLmStudio: (server: DiscoveredServer) => void;
  readonly seed: Seed | null;
}

interface ConnectionState {
  readonly form: FormValues;
  readonly rev: number;
  readonly found: readonly DiscoveredServer[];
  readonly action: ReturnType<typeof useAction>;
  readonly patch: (values: Partial<FormValues>, remount?: boolean) => void;
  readonly findLocal: () => void;
  readonly findModels: () => void;
  readonly save: () => void;
  readonly use: () => void;
  readonly useSuggestion: (server: DiscoveredServer) => void;
}

function suggestionOutcome(servers: readonly DiscoveredServer[]): Outcome {
  const found = reachableSuggestions(servers);
  return {
    tone: 'success',
    text:
      found.length === 0
        ? 'No local server answered on the usual ports. Enter a URL below.'
        : `${String(found.length)} local server${found.length === 1 ? '' : 's'} found. Nothing is selected.`,
  };
}

function useConnectionForm(engine: EngineInfo, seed: Seed | null): ConnectionState {
  const [form, setForm] = useState<FormValues>(() => initialForm(engine.connection, seed));
  // Bumped to remount the text inputs when a value is set from outside them.
  const [rev, setRev] = useState(0);
  const [found, setFound] = useState<readonly DiscoveredServer[]>([]);
  const save = useRpc(saveConnectionRpc);
  const select = useRpc(selectEngineRpc);
  const discover = useRpc(discoverServersRpc);
  const action = useAction();
  const engineId = engine.id;
  if (!isConnectable(engineId)) {
    throw new Error(`${engineId} has no connection settings`);
  }
  const patch = (values: Partial<FormValues>, remount = false): void => {
    setForm((f) => ({ ...f, ...values }));
    if (remount) {
      setRev((r) => r + 1);
    }
  };
  const saveForm = async (): Promise<Outcome | null> => {
    const built = buildConnectionPayload({ engine: engineId, ...form });
    if (!built.ok) {
      return { tone: 'error', text: built.error };
    }
    const res = await save(built.payload);
    return res.ok ? null : outcomeOf(res, '');
  };
  const run = (name: string, task: () => Promise<Outcome>): void => {
    void action.run(name, task);
  };
  return {
    form,
    rev,
    found,
    action,
    patch,
    findLocal: () =>
      run('suggest', async () => {
        const res = await discover({});
        setFound(res.suggestions);
        return res.ok ? suggestionOutcome(res.suggestions) : outcomeOf(res, '');
      }),
    findModels: () =>
      run('models', async () => {
        if (form.url.trim() === '') {
          return { tone: 'error', text: 'Enter the API base URL first.' };
        }
        const res = await discover({ engine: engineId, url: form.url.trim() });
        const server = res.server;
        if (!res.ok || server === null) {
          return outcomeOf({ ok: false, error: res.error }, '');
        }
        patch({ models: server.models });
        return {
          tone: server.state === 'reachable' ? 'success' : 'error',
          text: serverSummary(server),
        };
      }),
    save: () =>
      run('save', async () => {
        const failed = await saveForm();
        return failed ?? { tone: 'success', text: 'Saved. Press Use to switch the gateway to it.' };
      }),
    use: () =>
      run('use', async () => {
        const failed = await saveForm();
        if (failed !== null) {
          return failed;
        }
        const res = await select({ engine: engineId, model: form.model.trim(), device: 'auto' });
        return outcomeOf(
          res,
          `Switching to ${engine.label}. Decisions fail open until it is ready.`,
        );
      }),
    useSuggestion: (server: DiscoveredServer) => {
      patch({ url: server.url, models: server.models }, true);
    },
  };
}

function Suggestions({
  engine,
  found,
  onFill,
  onSetupLmStudio,
}: {
  engine: EngineInfo;
  found: readonly DiscoveredServer[];
  onFill: (server: DiscoveredServer) => void;
  onSetupLmStudio: (server: DiscoveredServer) => void;
}): ReactNode {
  const lm = engine.id === 'lmstudio' ? null : lmStudioSuggestion(found);
  return (
    <>
      {lm === null ? null : (
        <SettingsAction
          label="LM Studio"
          hint={lmStudioNote(lm)}
          actionLabel="Set up LM Studio"
          onPress={() => onSetupLmStudio(lm)}
        />
      )}
      {reachableSuggestions(found).map((s) => (
        <SettingsAction
          key={s.url}
          label={s.url}
          hint={`${s.kind === 'lmstudio' ? 'LM Studio' : 'OpenAI-compatible'} · ${String(s.models.length)} models`}
          actionLabel="Use URL"
          onPress={() => onFill(s)}
        />
      ))}
    </>
  );
}

export function ConnectionForm({ theme, engine, onSetupLmStudio, seed }: Props): ReactNode {
  const c = useConnectionForm(engine, seed);
  const busy = c.action.busy !== null;
  const label = (name: string, text: string): string =>
    c.action.busy === name ? 'Working…' : text;
  return (
    <SettingsCard>
      <SettingsInput
        key={`url:${String(c.rev)}`}
        label="API base URL"
        hint={engine.id === 'lmstudio' ? 'Usually http://127.0.0.1:1234/v1' : 'Ends with /v1'}
        initialValue={c.form.url}
        placeholder="http://127.0.0.1:1234/v1"
        onChangeText={(url) => c.patch({ url })}
      />
      <SettingsAction
        label="Find local servers"
        hint="Looks on the usual local ports. It does not select an engine."
        actionLabel={label('suggest', 'Find local servers')}
        disabled={busy}
        onPress={c.findLocal}
      />
      <Suggestions
        engine={engine}
        found={c.found}
        onFill={c.useSuggestion}
        onSetupLmStudio={onSetupLmStudio}
      />
      <SettingsAction
        label="Find models"
        hint="Asks the URL above for its models."
        actionLabel={label('models', 'Find models')}
        disabled={busy}
        onPress={c.findModels}
      />
      {c.form.models.length === 0 ? null : (
        <SettingsSelect
          label="Discovered models"
          value={c.form.models.includes(c.form.model) ? c.form.model : ''}
          options={[
            { label: 'Choose a model', value: '' },
            ...c.form.models.map((m) => ({ label: m, value: m })),
          ]}
          onValueChange={(model) => c.patch(model === '' ? {} : { model }, true)}
        />
      )}
      <SettingsInput
        key={`model:${String(c.rev)}`}
        label="Model"
        hint="Choose a discovered model above or type its id."
        initialValue={c.form.model}
        onChangeText={(model) => c.patch({ model })}
      />
      <SettingsInput
        key={`token:${engine.id}`}
        label="Token environment variable (optional)"
        hint="The name of a variable on the gateway machine, never the token itself."
        initialValue={c.form.tokenEnv}
        placeholder="LM_API_TOKEN"
        onChangeText={(tokenEnv) => c.patch({ tokenEnv })}
      />
      <SettingsAction
        label="Save"
        hint="Keeps the connection on the gateway without switching to it."
        actionLabel={label('save', 'Save')}
        disabled={busy}
        onPress={c.save}
      />
      <SettingsAction
        label="Use"
        hint={`Saves, then switches the gateway to ${engine.label}.`}
        actionLabel={label('use', 'Use')}
        disabled={busy}
        onPress={c.use}
      />
      {c.action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={c.action.outcome.tone} text={c.action.outcome.text} />
      )}
    </SettingsCard>
  );
}
