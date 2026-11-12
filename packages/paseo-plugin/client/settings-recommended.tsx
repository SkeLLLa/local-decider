/**
 * Card 1, "Recommended for this machine": renders `recommendedCard()` and runs its actions
 * through the existing RPCs (select engine, automatic mode, download, benchmark).
 */
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsRow } from '@getpaseo/plugin/client/ui';
import { useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { EngineCatalog } from '../shared/engines.ts';
import {
  recommendedCard,
  runtimeName,
  type CardAction,
  type RecommendedCard as Card,
} from '../shared/recommended-card.ts';
import {
  benchmarkStartRpc,
  downloadModelRpc,
  selectEngineRpc,
  selectionModeRpc,
} from '../shared/rpc.ts';
import { outcomeOf, useAction, type Outcome } from './hooks.ts';
import { InstallSteps } from './install.tsx';
import { Badge, Button, InlineMessage, type Theme, type Tone } from './ui.tsx';

type Runner = ReturnType<typeof useAction>;

interface Props {
  readonly theme: Theme;
  readonly catalog: EngineCatalog;
  /** Open the Advanced disclosure (Choose another…, Details, Connect a model server). */
  readonly onOpenAdvanced: () => void;
  /** Scroll to or open card 2; the "Go to benchmark" link shows only when this is given. */
  readonly onGoToBenchmark?: (() => void) | undefined;
}

const BADGE_TONE: Record<string, Tone> = { stale: 'warning', partial: 'info' };

function familyText(card: Card, catalog: EngineCatalog): string {
  return catalog.recommendation?.machine?.familyLabel ?? card.headline;
}

/** The runtime a `use` action switches to, e.g. `NPU`. */
function targetWord(catalog: EngineCatalog, a: CardAction): string {
  const t = a.target;
  return t === null ? 'this runtime' : runtimeName(catalog, { ...t, backend: null });
}

function useCardActions(
  card: Card,
  catalog: EngineCatalog,
  runner: Runner,
  onOpenAdvanced: () => void,
): {
  perform: (a: CardAction) => void;
  back: { family: string | null } | null;
  turnBackOn: () => void;
  steps: boolean;
  checkAgain: () => void;
} {
  const select = useRpc(selectEngineRpc);
  const setMode = useRpc(selectionModeRpc);
  const download = useRpc(downloadModelRpc);
  const start = useRpc(benchmarkStartRpc);
  const [back, setBack] = useState<{ family: string | null } | null>(null);
  const [steps, setSteps] = useState(false);
  const family = catalog.recommendation?.machine?.family ?? null;
  const familyInput = family === null ? {} : { family };

  const use = (a: CardAction): void => {
    const t = a.target;
    if (t === null) return;
    const wasAuto = card.mode === 'Automatic';
    const what = `${familyText(card, catalog)} on ${targetWord(catalog, a)}`;
    void runner.run('use', async () => {
      const res = await select({ engine: t.engine, model: t.model, device: t.device ?? 'auto' });
      setBack(res.ok && wasAuto ? { family } : null);
      return outcomeOf(
        res,
        wasAuto ? `Automatic is off. You're now on ${what}.` : `Now using ${what}.`,
      );
    });
  };
  const perform = (a: CardAction): void => {
    switch (a.kind) {
      case 'use':
        return use(a);
      case 'auto':
        setBack(null);
        return void runner.run('auto', async () =>
          outcomeOf(
            await setMode({ mode: 'auto', ...(a.family === null ? {} : { family: a.family }) }),
            'Automatic selection is on.',
          ),
        );
      case 'download':
        return void runner.run('download', async () =>
          outcomeOf(
            await download({ engine: a.target?.engine ?? '', model: a.target?.model ?? '' }),
            'Downloading. It can take a few minutes.',
          ),
        );
      case 'benchmark':
      case 'finish-benchmark':
        return void runner.run('benchmark', async () =>
          outcomeOf(
            await start({
              scope: 'family',
              ...familyInput,
              ...(a.kind === 'finish-benchmark' ? { only: 'missing' as const } : {}),
            }),
            'Benchmark started. Decisions are passed to you until it finishes.',
          ),
        );
      case 'install':
        return setSteps((open) => !open);
      case 'none':
        return;
      default:
        return onOpenAdvanced();
    }
  };
  return {
    perform,
    back,
    steps,
    turnBackOn: () => {
      const f = back?.family ?? null;
      setBack(null);
      void runner.run('auto', async () =>
        outcomeOf(
          await setMode({ mode: 'auto', ...(f === null ? {} : { family: f }) }),
          'Automatic selection is on.',
        ),
      );
    },
    checkAgain: () =>
      void runner.run('check', async () => ({ tone: 'success', text: 'Checked again.' })),
  };
}

function Buttons({
  theme,
  card,
  busy,
  onPress,
}: {
  theme: Theme;
  card: Card;
  busy: boolean;
  onPress: (a: CardAction) => void;
}): ReactNode {
  const all = [card.primary, ...card.secondary].filter((a) => a.kind !== 'none');
  if (all.length === 0) {
    return null;
  }
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {all.map((a, i) => (
        <Button
          key={`${a.kind}:${a.label}`}
          theme={theme}
          label={a.label}
          hint={a.hint}
          variant={i === 0 && a === card.primary ? 'primary' : 'secondary'}
          disabled={a.disabled || busy}
          onPress={() => onPress(a)}
        />
      ))}
    </View>
  );
}

function Lines({ theme, card }: { theme: Theme; card: Card }): ReactNode {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 };
  return (
    <>
      <Text
        accessibilityRole="header"
        style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: '600' }}
      >
        {card.headline}
      </Text>
      {card.latency === null ? null : <Text style={muted}>{card.latency}</Text>}
      {card.reasonText === null || card.reasonText === '' ? null : (
        <Text style={muted}>{card.reasonText}</Text>
      )}
      {card.badges.length === 0 ? null : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {card.badges.map((b) => (
            <Badge key={b.kind} theme={theme} text={b.label} tone={BADGE_TONE[b.kind] ?? 'info'} />
          ))}
        </View>
      )}
      {card.note === null ? null : <Text style={muted}>{card.note}</Text>}
    </>
  );
}

function Overlay({
  theme,
  card,
  onGo,
}: {
  theme: Theme;
  card: Card;
  onGo: (() => void) | undefined;
}): ReactNode {
  if (card.overlayText === null) {
    return null;
  }
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
        {card.overlayText}
      </Text>
      {card.overlayLink === null || onGo === undefined ? null : (
        <Button theme={theme} variant="secondary" label={card.overlayLink} onPress={onGo} />
      )}
    </View>
  );
}

function Result({
  theme,
  outcome,
  back,
  busy,
  onTurnBack,
}: {
  theme: Theme;
  outcome: Outcome | null;
  back: { family: string | null } | null;
  busy: boolean;
  onTurnBack: () => void;
}): ReactNode {
  return (
    <>
      {outcome === null ? null : (
        <InlineMessage theme={theme} tone={outcome.tone} text={outcome.text} />
      )}
      {back === null ? null : (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          <Button
            theme={theme}
            variant="secondary"
            label="Turn automatic back on"
            disabled={busy}
            onPress={onTurnBack}
          />
        </View>
      )}
    </>
  );
}

export function RecommendedCard({
  theme,
  catalog,
  onOpenAdvanced,
  onGoToBenchmark,
}: Props): ReactNode {
  const runner = useAction();
  const card = recommendedCard(catalog);
  const actions = useCardActions(card, catalog, runner, onOpenAdvanced);
  const machine = catalog.recommendation?.machine ?? null;
  if (machine === null && card.kind !== 'unsupported' && card.kind !== 'uncalibrated') {
    return null;
  }
  const busy = runner.busy !== null;
  const installTarget = card.primary.kind === 'install' ? card.primary.target : null;
  return (
    <SettingsCard>
      <SettingsRow label="Recommended for this machine">
        {card.mode === null ? null : <Badge theme={theme} text={card.mode} />}
      </SettingsRow>
      <View style={{ gap: 6, paddingHorizontal: 16, paddingVertical: 8 }}>
        <Lines theme={theme} card={card} />
        <Overlay theme={theme} card={card} onGo={onGoToBenchmark} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 }}>
          {card.status}
        </Text>
        {card.fasterFamilyText === null ? null : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            {card.fasterFamilyText}
          </Text>
        )}
        <Buttons theme={theme} card={card} busy={busy} onPress={actions.perform} />
      </View>
      {actions.steps && installTarget !== null ? (
        <InstallSteps
          theme={theme}
          engine={catalog.engines.find((e) => e.id === installTarget.engine) ?? null}
          target={installTarget}
          busy={busy}
          onCheck={actions.checkAgain}
        />
      ) : null}
      <Result
        theme={theme}
        outcome={runner.outcome}
        back={actions.back}
        busy={busy}
        onTurnBack={actions.turnBackOn}
      />
    </SettingsCard>
  );
}
