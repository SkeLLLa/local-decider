/**
 * Settings: the tools and directories the gateway uses. Each is discovered automatically unless
 * a custom path is set; the gateway checks a custom path before it accepts it.
 */
import { openExternalUrl, useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import {
  canSavePath,
  installHelp,
  middleEllipsis,
  pathDraftError,
  pathStatus,
  sourceBadge,
  type PathEntry,
} from '../shared/paths.ts';
import { setPathRpc } from '../shared/rpc.ts';
import { outcomeOf, useAction, useEngines } from './hooks.ts';
import { Badge, Button, InlineMessage, Mono, type Theme } from './ui.tsx';

function PathHeader({ theme, entry }: { theme: Theme; entry: PathEntry }): ReactNode {
  const help = installHelp(entry);
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 14 }} numberOfLines={1}>
          {entry.label}
        </Text>
        <Badge
          theme={theme}
          text={sourceBadge(entry)}
          tone={entry.source === 'missing' ? 'error' : 'info'}
        />
      </View>
      <Mono theme={theme}>{middleEllipsis(entry.effective ?? 'not found')}</Mono>
      <Text
        style={{
          color: entry.ok ? theme.colors.statusSuccess : theme.colors.statusDanger,
          fontSize: 12,
          lineHeight: 16,
        }}
      >
        {`${entry.ok ? '✓' : '✕'} ${pathStatus(entry)}`}
      </Text>
      {help === null ? null : (
        <View style={{ flexDirection: 'row' }}>
          <Button
            theme={theme}
            variant="secondary"
            label={help.label}
            onPress={() => void openExternalUrl(help.url)}
          />
        </View>
      )}
    </View>
  );
}

function PathEditor({
  theme,
  entry,
  busy,
  save,
}: {
  theme: Theme;
  entry: PathEntry;
  busy: boolean;
  save: (value: string | null) => void;
}): ReactNode {
  const [draft, setDraft] = useState(entry.value ?? '');
  return (
    <>
      <SettingsInput
        key={entry.value ?? ''}
        label="Custom path"
        initialValue={entry.value ?? ''}
        placeholder={entry.kind === 'directory' ? '/absolute/directory' : '/absolute/path/to/tool'}
        onChangeText={setDraft}
        error={draft.trim() === '' ? null : pathDraftError(draft)}
      />
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
        <Button
          theme={theme}
          label={busy ? 'Saving…' : 'Save'}
          disabled={busy || !canSavePath(draft, entry.value)}
          onPress={() => save(draft.trim())}
        />
        {entry.value === null ? null : (
          <Button
            theme={theme}
            variant="secondary"
            label="Use automatic"
            disabled={busy}
            onPress={() => save(null)}
          />
        )}
      </View>
    </>
  );
}

function PathRow({
  theme,
  entry,
  editable,
}: {
  theme: Theme;
  entry: PathEntry;
  editable: boolean;
}): ReactNode {
  const setPath = useRpc(setPathRpc);
  const action = useAction();
  const save = (value: string | null): void => {
    void action.run(entry.key, async () =>
      outcomeOf(
        await setPath({ key: entry.key, value }),
        value === null ? 'Back to automatic discovery.' : 'Saved.',
      ),
    );
  };
  return (
    <View>
      <PathHeader theme={theme} entry={entry} />
      {editable ? (
        <PathEditor theme={theme} entry={entry} busy={action.busy !== null} save={save} />
      ) : null}
      {action.outcome === null ? null : (
        <InlineMessage theme={theme} tone={action.outcome.tone} text={action.outcome.text} />
      )}
    </View>
  );
}

export function PathsSection({
  theme,
  gatewayUrl,
}: {
  theme: Theme;
  gatewayUrl: string;
}): ReactNode {
  const { data } = useEngines(gatewayUrl);
  const [open, setOpen] = useState(false);
  const paths = data?.paths ?? [];
  if (paths.length === 0) {
    return null;
  }
  const editable = data?.pathsEditable === true;
  const problems = paths.filter((p) => !p.ok).length;
  const summary = problems === 0 ? 'All found.' : `${String(problems)} not found or not working.`;
  return (
    <SettingsSection
      title="Paths"
      info="Where the gateway finds its tools and model directories. Each is found automatically unless you set a custom path; the gateway checks it before saving."
    >
      <SettingsCard>
        <SettingsAction
          label={`${String(paths.length)} tools and directories`}
          hint={
            editable ? summary : `${summary} Read-only: this gateway does not allow changes here.`
          }
          actionLabel={open ? 'Hide' : 'Show'}
          onPress={() => setOpen(!open)}
        />
      </SettingsCard>
      {open ? (
        <SettingsCard>
          {paths.map((entry) => (
            <PathRow key={entry.key} theme={theme} entry={entry} editable={editable} />
          ))}
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}
