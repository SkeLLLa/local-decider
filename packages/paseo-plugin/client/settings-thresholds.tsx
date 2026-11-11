/**
 * Settings → Decision thresholds (collapsed by default): the rule thresholds of each hook policy,
 * e.g. "auto-allow when verdict is allow" at p(allow) ≥ 0.95, as a slider with a number field.
 * They live in the gateway's config.yaml (`policies.<id>.thresholds`), so the Claude Code and
 * Codex hooks get the same decisions.
 */
import { useRpc } from '@getpaseo/plugin/client';
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  TextInput,
} from '@getpaseo/plugin/client/ui';
import { useQueries } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import { HOOK_POLICIES } from '../shared/constants.ts';
import {
  allowWarning,
  clampThreshold,
  parseThresholdInput,
  THRESHOLD_STEP,
  thresholdFloor,
  thresholdLabel,
  thresholdText,
  warningZones,
  type PolicyThresholds,
  type ThresholdSetting,
} from '../shared/policies.ts';
import { policyThresholdsRpc, setPolicyThresholdsRpc } from '../shared/rpc.ts';
import { outcomeOf, useAction } from './hooks.ts';
import { hostQueryKey, useHostId } from './host-scope.ts';
import { Slider } from './slider.tsx';
import { Button, InlineMessage, type Theme } from './ui.tsx';

interface RowProps {
  theme: Theme;
  /** The policy whose rules these are (the variant answering for `base`). */
  policy: string;
  base: string;
  threshold: ThresholdSetting;
}

/** The slider position and the number field's text, kept in step with the saved value. */
function useDraft(threshold: ThresholdSetting): {
  value: number;
  text: string;
  setValue: (value: number) => void;
  setText: (text: string) => void;
} {
  const saved = threshold.value ?? thresholdFloor(threshold);
  const [value, setValueState] = useState(saved);
  const [text, setText] = useState(saved.toFixed(2));
  useEffect(() => {
    setValueState(saved);
    setText(saved.toFixed(2));
  }, [saved]);
  const setValue = (next: number): void => {
    setValueState(next);
    setText(next.toFixed(2));
  };
  return { value, text, setValue, setText };
}

function NumberField({
  theme,
  label,
  text,
  disabled,
  onChangeText,
  onCommit,
}: {
  theme: Theme;
  label: string;
  text: string;
  disabled: boolean;
  onChangeText: (text: string) => void;
  onCommit: () => void;
}): ReactNode {
  return (
    <TextInput
      accessibilityLabel={label}
      value={text}
      editable={!disabled}
      inputMode="decimal"
      keyboardType="decimal-pad"
      selectTextOnFocus
      onChangeText={onChangeText}
      onBlur={onCommit}
      onSubmitEditing={onCommit}
      style={{
        width: 56,
        paddingVertical: 4,
        paddingHorizontal: 6,
        borderWidth: 1,
        borderRadius: 6,
        borderColor: theme.colors.border,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        fontSize: 13,
        textAlign: 'right',
        fontVariant: ['tabular-nums'],
      }}
    />
  );
}

function ThresholdRow({ theme, policy, base, threshold }: RowProps): ReactNode {
  const set = useRpc(setPolicyThresholdsRpc);
  const { busy, outcome, run } = useAction();
  const draft = useDraft(threshold);
  const [inputError, setInputError] = useState<string | null>(null);
  const saved = threshold.value ?? thresholdFloor(threshold);
  const apply = (value: number | null): void => {
    if (value === saved) {
      return;
    }
    void run(threshold.key, async () =>
      outcomeOf(await set({ policy, thresholds: { [threshold.key]: value } }), 'Saved.'),
    );
  };
  const commitText = (): void => {
    const parsed = parseThresholdInput(threshold, draft.text);
    setInputError(parsed.error);
    if (parsed.value === null) {
      draft.setText(draft.value.toFixed(2));
      return;
    }
    draft.setValue(parsed.value);
    apply(parsed.value);
  };
  const label = thresholdLabel(threshold);
  const warning = allowWarning(threshold, draft.value);
  const owner = policy === base ? '' : `${policy}: `;
  const changed = threshold.value !== threshold.default;
  return (
    <>
      <SettingsRow label={label} hint={`${owner}${thresholdText(threshold)}`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Slider
            theme={theme}
            label={label}
            value={draft.value}
            min={thresholdFloor(threshold)}
            max={1}
            step={THRESHOLD_STEP}
            zones={warningZones(threshold)}
            disabled={busy !== null}
            onChange={(value) => draft.setValue(clampThreshold(threshold, value))}
            onCommit={(value) => apply(clampThreshold(threshold, value))}
          />
          <NumberField
            theme={theme}
            label={`${label}, value`}
            text={draft.text}
            disabled={busy !== null}
            onChangeText={draft.setText}
            onCommit={commitText}
          />
          {changed ? (
            <Button
              theme={theme}
              variant="secondary"
              icon="RotateCcw"
              label="Reset"
              disabled={busy !== null}
              onPress={() => apply(null)}
            />
          ) : null}
        </View>
      </SettingsRow>
      {inputError === null ? null : <InlineMessage theme={theme} tone="error" text={inputError} />}
      {warning === null ? null : (
        <InlineMessage theme={theme} tone={warning.strong ? 'error' : 'info'} text={warning.text} />
      )}
      {outcome?.tone === 'error' ? (
        <InlineMessage theme={theme} tone="error" text={outcome.text} />
      ) : null}
    </>
  );
}

function PolicyCard({
  theme,
  base,
  data,
}: {
  theme: Theme;
  base: string;
  data: PolicyThresholds;
}): ReactNode {
  if (data.policy === null || data.thresholds.length === 0) {
    return null;
  }
  const answering = data.policy;
  return (
    <SettingsCard>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: '600' }}>
          {answering === base ? base : `${base} (${answering})`}
        </Text>
      </View>
      {data.thresholds.map((threshold) => (
        <ThresholdRow
          key={threshold.key}
          theme={theme}
          policy={answering}
          base={base}
          threshold={threshold}
        />
      ))}
    </SettingsCard>
  );
}

function summaryOf(all: readonly ThresholdSetting[]): string {
  const changed = all.filter((t) => t.value !== t.default).length;
  const risky = all.some((t) => allowWarning(t) !== null);
  const parts = [changed === 0 ? 'All at their defaults.' : `${String(changed)} changed.`];
  if (risky) {
    parts.push('Auto-allow is lowered below the recommended 0.90.');
  }
  return parts.join(' ');
}

/** Hidden while the gateway is unreachable or has no thresholds; rows only once expanded. */
export function ThresholdsSection({
  theme,
  gatewayUrl,
}: {
  theme: Theme;
  gatewayUrl: string;
}): ReactNode {
  const list = useRpc(policyThresholdsRpc);
  const hostId = useHostId();
  const [open, setOpen] = useState(false);
  const results = useQueries({
    queries: HOOK_POLICIES.map((policy) => ({
      queryKey: hostQueryKey(hostId, 'policy-thresholds', policy, gatewayUrl),
      queryFn: async () => list({ policy }),
      retry: false,
      staleTime: 10_000,
    })),
  });
  const loaded = HOOK_POLICIES.flatMap((policy, i) => {
    const data = results[i]?.data;
    return data?.ok === true ? [{ policy, data }] : [];
  });
  const all = loaded.flatMap(({ data }) => data.thresholds);
  if (all.length === 0) {
    return null;
  }
  return (
    <SettingsSection
      title="Decision thresholds"
      info="How sure the local model must be before a rule acts, e.g. auto-allowing a permission. Saved in the gateway's config.yaml, so the Claude Code and Codex hooks use them too."
    >
      <SettingsCard>
        <SettingsAction
          label={`${String(all.length)} rule thresholds`}
          hint={summaryOf(all)}
          actionLabel={open ? 'Hide' : 'Show'}
          onPress={() => setOpen(!open)}
        />
      </SettingsCard>
      {open
        ? loaded.map(({ policy, data }) => (
            <PolicyCard key={policy} theme={theme} base={policy} data={data} />
          ))
        : null}
    </SettingsSection>
  );
}
