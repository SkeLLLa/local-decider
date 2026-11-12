/**
 * Card 2, "Benchmark this machine": renders `benchmarkCard()` for the job `useBenchmark` polls and
 * runs its actions through the benchmark, select-engine and selection-mode RPCs.
 */
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsCard, SettingsRow } from '@getpaseo/plugin/client/ui';
import { useRef, type ReactNode } from 'react';
import { Text, View } from 'react-native';

import {
  benchmarkCard,
  type BenchAction,
  type BenchmarkCard as Card,
  type ResultGroup,
  type ResultRow,
} from '../shared/benchmark-card.ts';
import type { BenchmarkView } from '../shared/benchmark.ts';
import type { EngineCatalog } from '../shared/engines.ts';
import {
  benchmarkCancelRpc,
  benchmarkStartRpc,
  selectEngineRpc,
  selectionModeRpc,
} from '../shared/rpc.ts';
import { outcomeOf, useAction } from './hooks.ts';
import { Badge, Button, Disclosure, Progress, type Theme, type Tone } from './ui.tsx';

/** Presses of Cancel closer together than this are one press. */
const CANCEL_GUARD_MS = 500;

interface Props {
  readonly theme: Theme;
  readonly catalog: EngineCatalog;
  /** The job from `useBenchmark`: undefined while loading, null when the gateway has none. */
  readonly view: BenchmarkView | null | undefined;
  /** Whether the results are open; null leaves it to the card (open right after a run). */
  readonly resultsOpen: boolean | null;
  readonly onResultsOpen: (open: boolean) => void;
}

type Runner = ReturnType<typeof useAction>;

function startBody(a: BenchAction): Record<string, unknown> {
  if (a.targets.length > 0) {
    return {
      targets: a.targets.slice(0, 32).map((t) => ({
        engine: t.engine,
        model: t.model,
        ...(t.device === null ? {} : { device: t.device }),
      })),
    };
  }
  return { scope: 'installed', ...(a.only === null ? {} : { only: a.only }) };
}

function useBenchmarkActions(runner: Runner, onShowResults: () => void): (a: BenchAction) => void {
  const start = useRpc(benchmarkStartRpc);
  const cancel = useRpc(benchmarkCancelRpc);
  const select = useRpc(selectEngineRpc);
  const setMode = useRpc(selectionModeRpc);
  const lastCancel = useRef(0);
  const startRun = (a: BenchAction): void =>
    void runner.run('start', async () =>
      outcomeOf(
        await start(startBody(a)),
        'Benchmark started. Decisions are passed to you until it finishes.',
      ),
    );
  const selectTarget = (a: BenchAction, text: string): void => {
    const t = a.targets[0];
    if (t === undefined) return;
    void runner.run('select', async () =>
      outcomeOf(
        await select({ engine: t.engine, model: t.model, device: t.device ?? 'auto' }),
        text,
      ),
    );
  };
  return (a) => {
    switch (a.kind) {
      case 'cancel': {
        const now = Date.now();
        if (now - lastCancel.current < CANCEL_GUARD_MS) return;
        lastCancel.current = now;
        return void runner.run('cancel', async () =>
          outcomeOf(await cancel({}), 'Cancelling. Completed results are kept.'),
        );
      }
      case 'auto':
        return void runner.run('auto', async () =>
          outcomeOf(
            await setMode({ mode: 'auto', ...(a.family === null ? {} : { family: a.family }) }),
            'Automatic selection is on.',
          ),
        );
      case 'use':
        return selectTarget(a, 'Switching. Decisions fail open until it is ready.');
      case 'restore':
        return selectTarget(a, 'Switching back. Decisions fail open until it is ready.');
      case 'show-results':
        return onShowResults();
      default:
        return startRun(a);
    }
  };
}

function ActionButton({
  theme,
  action,
  busy,
  primary = false,
  onPress,
}: {
  theme: Theme;
  action: BenchAction;
  busy: boolean;
  primary?: boolean;
  onPress: (a: BenchAction) => void;
}): ReactNode {
  return (
    <Button
      theme={theme}
      label={action.label}
      hint={action.hint}
      variant={primary ? 'primary' : 'secondary'}
      disabled={action.disabled || (busy && action.kind !== 'cancel')}
      onPress={() => onPress(action)}
    />
  );
}

function Controls({
  theme,
  card,
  busy,
  onPress,
}: {
  theme: Theme;
  card: Card;
  busy: boolean;
  onPress: (a: BenchAction) => void;
}): ReactNode {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <ActionButton theme={theme} action={card.primary} busy={busy} primary onPress={onPress} />
      {card.secondary.map((a) => (
        <ActionButton key={a.label} theme={theme} action={a} busy={busy} onPress={onPress} />
      ))}
    </View>
  );
}

function Muted({ theme, children }: { theme: Theme; children: string }): ReactNode {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 }}>
      {children}
    </Text>
  );
}

function Status({ theme, card }: { theme: Theme; card: Card }): ReactNode {
  const p = card.progress;
  return (
    <>
      <Muted theme={theme}>{card.description}</Muted>
      {card.summary === null ? null : (
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{card.summary}</Text>
      )}
      {card.detail === null ? null : <Muted theme={theme}>{card.detail}</Muted>}
      {card.activity === null ? null : (
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{card.activity}</Text>
      )}
      {p === null ? null : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Progress theme={theme} value={p.fraction} />
          <Muted theme={theme}>{p.text}</Muted>
        </View>
      )}
      {card.startedNote === null ? null : <Muted theme={theme}>{card.startedNote}</Muted>}
      {card.status === null ? null : (
        <Text style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 18 }}>
          {card.status}
        </Text>
      )}
    </>
  );
}

function RestoreFailure({
  theme,
  failure,
  busy,
  onPress,
}: {
  theme: Theme;
  failure: NonNullable<Card['restoreFailure']>;
  busy: boolean;
  onPress: (a: BenchAction) => void;
}): ReactNode {
  return (
    <View
      accessibilityRole="alert"
      style={{
        gap: 8,
        padding: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
      }}
    >
      <Text style={{ color: theme.colors.statusDanger, fontSize: 13, lineHeight: 18 }}>
        {failure.text}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <ActionButton theme={theme} action={failure.retry} busy={busy} primary onPress={onPress} />
        <ActionButton theme={theme} action={failure.auto} busy={busy} onPress={onPress} />
      </View>
    </View>
  );
}

// ── results table ────────────────────────────────────────────────────────────────────────────

const BADGE_TONE: Record<string, Tone> = {
  'fastest': 'success',
  'stale': 'warning',
  'failed': 'error',
  'in-use': 'info',
};

const FLEX = { runtime: 3, format: 3, number: 2 } as const;

function Cell({
  theme,
  text,
  flex,
  muted = false,
}: {
  theme: Theme;
  text: string | null;
  flex: number;
  muted?: boolean;
}): ReactNode {
  return (
    <Text
      style={{
        flex,
        color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: 13,
      }}
    >
      {text ?? '—'}
    </Text>
  );
}

function HeaderRow({ theme, showK2 }: { theme: Theme; showK2: boolean }): ReactNode {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Cell theme={theme} text="Runtime" flex={FLEX.runtime} muted />
      <Cell theme={theme} text="Format" flex={FLEX.format} muted />
      <Cell theme={theme} text="Typical" flex={FLEX.number} muted />
      <Cell theme={theme} text="Long" flex={FLEX.number} muted />
      <Cell theme={theme} text="256" flex={FLEX.number} muted />
      {showK2 ? <Cell theme={theme} text="2k" flex={FLEX.number} muted /> : null}
    </View>
  );
}

function Badges({ theme, row }: { theme: Theme; row: ResultRow }): ReactNode {
  if (row.badges.length === 0) {
    return null;
  }
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      {row.badges.map((b) => (
        <Badge key={b.kind} theme={theme} text={b.label} tone={BADGE_TONE[b.kind] ?? 'info'} />
      ))}
    </View>
  );
}

function Numbers({
  theme,
  row,
  showK2,
}: {
  theme: Theme;
  row: ResultRow;
  showK2: boolean;
}): ReactNode {
  if (row.text !== null) {
    return (
      <Text
        style={{
          flex: FLEX.number * (showK2 ? 4 : 3),
          color: theme.colors.foregroundMuted,
          fontSize: 13,
        }}
      >
        {row.text}
      </Text>
    );
  }
  return (
    <>
      <Cell theme={theme} text={row.typical} flex={FLEX.number} />
      <Cell theme={theme} text={row.long} flex={FLEX.number} />
      <Cell theme={theme} text={row.p256} flex={FLEX.number} />
      {showK2 ? <Cell theme={theme} text={row.k2} flex={FLEX.number} /> : null}
    </>
  );
}

function Row({
  theme,
  row,
  showK2,
  busy,
  onPress,
}: {
  theme: Theme;
  row: ResultRow;
  showK2: boolean;
  busy: boolean;
  onPress: (a: BenchAction) => void;
}): ReactNode {
  return (
    <View style={{ gap: 4 }}>
      <View
        accessible
        accessibilityLabel={row.accessibleName}
        style={{ flexDirection: 'row', gap: 8 }}
      >
        <View style={{ flex: FLEX.runtime, gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{row.runtime}</Text>
          <Badges theme={theme} row={row} />
        </View>
        <Cell theme={theme} text={row.format} flex={FLEX.format} muted />
        <Numbers theme={theme} row={row} showK2={showK2} />
      </View>
      {row.hint === null ? null : <Muted theme={theme}>{row.hint}</Muted>}
      {row.error === null ? null : <Muted theme={theme}>{row.error}</Muted>}
      {row.action === null ? null : (
        <ActionButton theme={theme} action={row.action} busy={busy} onPress={onPress} />
      )}
    </View>
  );
}

function Group({
  theme,
  group,
  showK2,
  busy,
  onPress,
}: {
  theme: Theme;
  group: ResultGroup;
  showK2: boolean;
  busy: boolean;
  onPress: (a: BenchAction) => void;
}): ReactNode {
  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: '600' }}
        >
          {group.label}
        </Text>
        {group.useFastest === null ? null : (
          <ActionButton theme={theme} action={group.useFastest} busy={busy} onPress={onPress} />
        )}
      </View>
      <HeaderRow theme={theme} showK2={showK2} />
      {group.rows.map((row) => (
        <Row key={row.key} theme={theme} row={row} showK2={showK2} busy={busy} onPress={onPress} />
      ))}
    </View>
  );
}

function Results({
  theme,
  card,
  busy,
  open,
  onOpen,
  onPress,
}: {
  theme: Theme;
  card: Card;
  busy: boolean;
  open: boolean | null;
  onOpen: (open: boolean) => void;
  onPress: (a: BenchAction) => void;
}): ReactNode {
  if (card.groups.length === 0) {
    return null;
  }
  return (
    <Disclosure
      theme={theme}
      title="Results"
      expanded={open ?? card.resultsExpanded}
      onExpandedChange={onOpen}
    >
      <View style={{ gap: 16 }}>
        {card.groups.map((g) => (
          <Group
            key={g.family}
            theme={theme}
            group={g}
            showK2={card.showK2}
            busy={busy}
            onPress={onPress}
          />
        ))}
      </View>
    </Disclosure>
  );
}

export function BenchmarkCard({
  theme,
  catalog,
  view,
  resultsOpen,
  onResultsOpen,
}: Props): ReactNode {
  const runner = useAction();
  const perform = useBenchmarkActions(runner, () => onResultsOpen(true));
  if (view == null) {
    // No benchmark endpoint (older gateway), or not read yet.
    return null;
  }
  const card = benchmarkCard(view, catalog);
  const busy = runner.busy !== null;
  return (
    <SettingsCard>
      <SettingsRow label="Benchmark this machine">
        {card.stateLabel === null ? null : <Badge theme={theme} text={card.stateLabel} />}
      </SettingsRow>
      <View style={{ gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
        <Status theme={theme} card={card} />
        <Controls theme={theme} card={card} busy={busy} onPress={perform} />
        {card.restoreFailure === null ? null : (
          <RestoreFailure
            theme={theme}
            failure={card.restoreFailure}
            busy={busy}
            onPress={perform}
          />
        )}
        {runner.outcome === null ? null : (
          <Text
            accessibilityRole={runner.outcome.tone === 'error' ? 'alert' : 'text'}
            style={{
              color:
                runner.outcome.tone === 'error'
                  ? theme.colors.statusDanger
                  : theme.colors.foregroundMuted,
              fontSize: 13,
            }}
          >
            {runner.outcome.text}
          </Text>
        )}
        <Results
          theme={theme}
          card={card}
          busy={busy}
          open={resultsOpen}
          onOpen={onResultsOpen}
          onPress={perform}
        />
        {card.footer.map((line) => (
          <Muted key={line} theme={theme}>
            {line}
          </Muted>
        ))}
        <Text accessibilityLiveRegion="polite" style={{ height: 0, opacity: 0 }}>
          {card.announcement ?? ''}
        </Text>
      </View>
    </SettingsCard>
  );
}
