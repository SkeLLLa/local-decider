/**
 * Routing presets as a table: one row per preset with its target (a Paseo agent profile or a
 * model), effort (thinking level) and mode side by side. Every change is written to the
 * gateway's config.yaml (`routing.presets.paseo`); a failed write shows as a toast.
 */
import { usePaseo, useRpc } from '@getpaseo/plugin/client';
import { Icon, useToast } from '@getpaseo/plugin/client/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import type { PresetTargetSetting } from '../shared/policies.ts';
import {
  parsePresetModel,
  type ModelOption,
  type ProfileLike,
  type ThinkingChoices,
} from '../shared/presets.ts';
import { routingPresetRpc } from '../shared/rpc.ts';
import { ChipPicker, type ChipOption } from './chip-picker.tsx';
import type { Theme } from './ui.tsx';

const PROFILE_PREFIX = 'profile:';
const COLUMNS = { route: 120, effort: 120, mode: 140 } as const;

/** Paseo's agent profiles, for profile targets. */
function useProfiles(): readonly ProfileLike[] {
  const paseo = usePaseo();
  const query = useQuery({
    queryKey: ['local-decider', 'agent-profiles'],
    queryFn: async () => (await paseo.config.get()).config.agentProfiles ?? [],
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? [];
}

function profileDetail(p: ProfileLike): string {
  return [p.provider, p.model, p.thinkingOptionId, p.modeId].filter(Boolean).join(' · ');
}

function targetOptions(
  profiles: readonly ProfileLike[],
  models: readonly ModelOption[],
): ChipOption[] {
  return [
    { label: 'Not mapped', value: '' },
    ...profiles.map((p) => ({
      label: p.name ?? p.id,
      value: `${PROFILE_PREFIX}${p.id}`,
      group: 'Profiles',
      detail: profileDetail(p),
    })),
    ...models.filter((m) => m.value !== '').map((m) => ({ ...m, group: 'Models' })),
  ];
}

function targetValue(target: PresetTargetSetting | undefined): string {
  if (target?.profile !== undefined) {
    return `${PROFILE_PREFIX}${target.profile}`;
  }
  return target?.model ?? '';
}

function Cell({ width, children }: { width?: number; children: ReactNode }): ReactNode {
  return (
    <View style={width === undefined ? { flex: 1, minWidth: 140 } : { width }}>{children}</View>
  );
}

function Muted({ theme, text }: { theme: Theme; text: string }): ReactNode {
  return (
    <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
      {text}
    </Text>
  );
}

interface RowProps {
  readonly theme: Theme;
  readonly preset: string;
  readonly used: boolean;
  readonly target: PresetTargetSetting | undefined;
  readonly models: readonly ModelOption[];
  readonly thinking: ReadonlyMap<string, ThinkingChoices>;
  readonly profiles: readonly ProfileLike[];
}

function useWrite(preset: string): (fields: Omit<PresetTargetSetting, never>) => void {
  const setPreset = useRpc(routingPresetRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  return (fields) => {
    void setPreset({ preset, ...fields })
      .then((res) => {
        if (!res.ok) {
          toast.error(`route:${preset}: ${res.error ?? 'not saved'}`);
        }
      })
      .catch((error: unknown) => toast.error(`route:${preset}: ${String(error)}`))
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: ['local-decider', 'routing-settings'] });
      });
  };
}

/** A cell without a picker: what a profile sets, or a dash when the model offers no choice. */
function fixedCellText(
  target: PresetTargetSetting | undefined,
  hasChoices: boolean,
  value: string | undefined,
): string | null {
  if (target?.profile !== undefined) {
    return value ?? 'profile';
  }
  return hasChoices ? null : '—';
}

function EffortCell({
  theme,
  preset,
  target,
  thinking,
  write,
}: Omit<RowProps, 'used' | 'models' | 'profiles'> & {
  write: ReturnType<typeof useWrite>;
}): ReactNode {
  const model = target?.model ?? '';
  const choices = model === '' ? undefined : thinking.get(model);
  if (target?.profile !== undefined) {
    return <Muted theme={theme} text={target.thinking ?? 'profile'} />;
  }
  if (choices === undefined) {
    return <Muted theme={theme} text="—" />;
  }
  const options = [
    { label: choices.defaultId === '' ? 'Default' : `Default (${choices.defaultId})`, value: '' },
    ...choices.options,
  ];
  return (
    <ChipPicker
      theme={theme}
      icon="Brain"
      title={`route:${preset} effort`}
      value={target?.thinking ?? ''}
      options={options}
      onChange={(value) =>
        write({
          model,
          ...(target?.mode === undefined ? {} : { mode: target.mode }),
          ...(value === '' ? {} : { thinking: value }),
        })
      }
    />
  );
}

function ModeCell({
  theme,
  preset,
  target,
  write,
}: Pick<RowProps, 'theme' | 'preset' | 'target'> & {
  write: ReturnType<typeof useWrite>;
}): ReactNode {
  const paseo = usePaseo();
  const model = target?.model ?? '';
  const provider = parsePresetModel(model)?.provider ?? null;
  const modes = useQuery({
    queryKey: ['local-decider', 'provider-modes', provider],
    queryFn: async () => (provider === null ? null : paseo.providers.listModes(provider)),
    enabled: provider !== null && target?.profile === undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const list = modes.data?.modes ?? [];
  const fixed = fixedCellText(target, provider !== null && list.length > 0, target?.mode);
  if (fixed !== null) {
    return <Muted theme={theme} text={fixed} />;
  }
  return (
    <ChipPicker
      theme={theme}
      icon="Shield"
      title={`route:${preset} mode`}
      value={target?.mode ?? ''}
      options={[
        { label: 'Default', value: '' },
        ...list.map((m) => ({ label: m.label, value: m.id })),
      ]}
      onChange={(value) =>
        write({
          model,
          ...(target?.thinking === undefined ? {} : { thinking: target.thinking }),
          ...(value === '' ? {} : { mode: value }),
        })
      }
    />
  );
}

function PresetRow(props: RowProps): ReactNode {
  const { theme, preset, used, target, models, profiles } = props;
  const write = useWrite(preset);
  const onTarget = (value: string): void =>
    value.startsWith(PROFILE_PREFIX)
      ? write({ profile: value.slice(PROFILE_PREFIX.length) })
      : write(value === '' ? {} : { model: value });
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      }}
    >
      <Cell width={COLUMNS.route}>
        <Text
          numberOfLines={1}
          style={{
            color: used ? theme.colors.foreground : theme.colors.foregroundMuted,
            fontSize: 14,
          }}
        >
          {preset}
        </Text>
        {used ? null : <Muted theme={theme} text="not in this policy" />}
      </Cell>
      <Cell>
        <ChipPicker
          theme={theme}
          title={`route:${preset} target`}
          value={targetValue(target)}
          options={targetOptions(profiles, models)}
          onChange={onTarget}
        />
      </Cell>
      <Cell width={COLUMNS.effort}>
        <EffortCell {...props} write={write} />
      </Cell>
      <Cell width={COLUMNS.mode}>
        <ModeCell theme={theme} preset={preset} target={target} write={write} />
      </Cell>
      {used ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove route:${preset}`}
          onPress={() => write({})}
        >
          <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
        </Pressable>
      )}
    </View>
  );
}

function Header({ theme }: { theme: Theme }): ReactNode {
  const head = (text: string): ReactNode => (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textTransform: 'uppercase' }}>
      {text}
    </Text>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 6,
      }}
    >
      <Cell width={COLUMNS.route}>{head('Route')}</Cell>
      <Cell>{head('Profile or model')}</Cell>
      <Cell width={COLUMNS.effort}>{head('Effort')}</Cell>
      <Cell width={COLUMNS.mode}>{head('Mode')}</Cell>
    </View>
  );
}

export function PresetTable({
  theme,
  rows,
  presets,
  models,
  thinking,
}: {
  theme: Theme;
  rows: readonly { name: string; used: boolean }[];
  presets: Readonly<Record<string, PresetTargetSetting>>;
  models: readonly ModelOption[];
  thinking: ReadonlyMap<string, ThinkingChoices>;
}): ReactNode {
  const profiles = useProfiles();
  if (rows.length === 0) {
    return null;
  }
  return (
    <View>
      <Header theme={theme} />
      {rows.map(({ name, used }) => (
        <PresetRow
          key={name}
          theme={theme}
          preset={name}
          used={used}
          target={presets[name]}
          models={models}
          thinking={thinking}
          profiles={profiles}
        />
      ))}
    </View>
  );
}
