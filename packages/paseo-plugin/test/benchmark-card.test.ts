import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { benchmarkCard } from '../shared/benchmark-card.ts';
import { parseBenchmark, type BenchmarkView } from '../shared/benchmark.ts';
import { parseEngineCatalog, type EngineCatalog } from '../shared/engines.ts';

type Obj = Record<string, unknown>;

const NOON = '2026-11-12T12:00:00.000Z';

function measured(p50: number, p95: number, extra: Obj = {}): Obj {
  return {
    device: null,
    typical: { p50Ms: p50, p95Ms: p95 },
    long: { p50Ms: p50 * 3, p95Ms: p50 * 4 },
    sizes: [{ targetTokens: 256, inputTokens: 301, p50Ms: Math.round(p50 / 2), p95Ms: p95 }],
    runs: 5,
    provisional: false,
    measuredAt: NOON,
    freshness: 'fresh',
    staleReason: null,
    failed: null,
    ...extra,
  };
}

function model(
  engine: string,
  id: string,
  family: [string, string],
  format: [string, string] | null,
  m: Obj[],
  extra: Obj = {},
): Obj {
  return {
    id,
    engine,
    label: id,
    installed: true,
    fits: true,
    family: { id: family[0], label: family[1] },
    format: format === null ? null : { short: format[0], label: format[1] },
    measured: m,
    ...extra,
  };
}

const NPU_FORMAT: [string, string] = ['FLM', 'NPU (FLM)'];
const Q4: [string, string] = ['Q4_K_M', '4-bit Q4_K_M'];

function lite(npu: Obj, vulkan: Obj): Obj[] {
  return [
    model('fastflowlm', 'd3:lite', ['f/lite', 'd3 lite'], NPU_FORMAT, [npu]),
    model('llama-vulkan', 'd3-lite-q4', ['f/lite', 'd3 lite'], Q4, [vulkan]),
  ];
}

const MODELS: Obj[] = [
  ...lite(measured(520, 555), measured(460, 1000)),
  model('fastflowlm', 'd3:mini', ['f/mini', 'd3 mini'], NPU_FORMAT, [measured(1687, 1900)]),
  model('llama-vulkan', 'd3-mini-q4', ['f/mini', 'd3 mini'], Q4, [measured(2307, 2500)]),
  model('llama-vulkan', 'd3-mini-q8', ['f/mini', 'd3 mini'], ['Q8_0', '8-bit Q8_0'], []),
  model('fastflowlm', 'd3:nano', ['f/nano', 'd3 nano'], NPU_FORMAT, [measured(760, 800)]),
  model('strands-decider', 'strands-2b', ['s/2b', 'Strands 2B'], null, [
    measured(2400, 2600, { device: 'cpu' }),
    measured(0, 0, {
      device: 'cuda',
      typical: null,
      long: null,
      failed: { error: 'out of memory', at: NOON },
    }),
  ]),
];

const NPU_OPTION = { engine: 'fastflowlm', model: 'd3:lite', device: null, backend: 'NPU' };

function catalog(models: Obj[] = MODELS, active: Obj = {}): EngineCatalog {
  return parseEngineCatalog({
    active: {
      engine: 'fastflowlm',
      model: 'd3:lite',
      state: 'ready',
      selectionMode: 'auto',
      ...active,
    },
    engines: [
      { id: 'fastflowlm', label: 'FastFlowLM' },
      { id: 'llama-vulkan', label: 'llama.cpp (Vulkan)' },
      { id: 'strands-decider', label: 'Strands' },
    ],
    models,
    recommendation: {
      candidates: [],
      machine: {
        family: 'f/lite',
        familyLabel: 'd3 lite',
        best: NPU_OPTION,
        runtimes: [
          { engine: 'fastflowlm', device: null, backend: 'NPU', pick: null, variants: [] },
          { engine: 'llama-vulkan', device: null, backend: 'Vulkan', pick: null, variants: [] },
        ],
      },
    },
  });
}

function view(extra: Obj = {}): BenchmarkView {
  const v = parseBenchmark({
    state: 'idle',
    sizes: [256, 1024, 3800],
    runs: 5,
    total: 6,
    completed: 0,
    failed: 0,
    targets: [],
    ...extra,
  });
  assert.ok(v !== null);
  return v;
}

const target = (engine: string, model_: string, state: string, extra: Obj = {}): Obj => ({
  engine,
  model: model_,
  device: null,
  family: null,
  state,
  ...extra,
});

describe('benchmark card: idle', () => {
  it('summarises the preview as run time, not latency', () => {
    const card = benchmarkCard(
      view({ preview: { total: 6, etaSeconds: 330, excluded: ['openai-compatible'] } }),
      catalog(),
    );
    assert.equal(card.state, 'idle');
    assert.equal(card.summary, 'About 6 min · 6 runtimes');
    assert.match(card.detail ?? '', /Custom servers aren't benchmarked\.$/);
    assert.equal(card.primary.kind, 'run');
    assert.equal(card.primary.label, 'Run benchmark');
    assert.equal(card.primary.disabled, false);
    assert.equal(card.progress, null);
  });

  it('has no summary without a preview, and a disabled button for zero targets', () => {
    const none = benchmarkCard(view(), catalog());
    assert.equal(none.summary, null);
    assert.equal(none.primary.disabled, false);
    const empty = benchmarkCard(
      view({ preview: { total: 0, etaSeconds: null, excluded: [] } }),
      catalog(),
    );
    assert.equal(empty.primary.disabled, true);
    assert.equal(empty.primary.hint, 'Install a runtime first; see the recommendation above.');
    const gone = benchmarkCard(null, catalog());
    assert.equal(gone.primary.disabled, true);
    assert.equal(gone.state, 'idle');
  });

  it('makes Run again primary when a shown result is out of date', () => {
    const stale = lite(measured(520, 555, { freshness: 'stale' }), measured(460, 500));
    const card = benchmarkCard(view(), catalog(stale));
    assert.equal(card.primary.label, 'Run again');
    const row = card.groups[0]?.rows.find((r) => r.engine === 'fastflowlm');
    assert.deepEqual(
      row?.badges.map((b) => b.label),
      ['Fastest here', 'In use', 'Out of date'],
    );
    assert.equal(row?.hint, 'Out of date — run again.');
    assert.equal(row?.typical, '520 ms');
    assert.equal(card.footer.at(-1), 'Results are from this machine only.');
  });
});

const running = (extra: Obj = {}): BenchmarkView =>
  view({
    state: 'running',
    phase: 'measuring',
    completed: 3,
    etaSeconds: 170,
    startedBy: 'cli',
    current: {
      engine: 'fastflowlm',
      model: 'd3:mini',
      device: null,
      family: 'f/mini',
      promptTokens: 3800,
    },
    restore: {
      mode: 'auto',
      engine: 'fastflowlm',
      model: 'd3:lite',
      device: null,
      family: 'f/lite',
    },
    targets: [
      target('fastflowlm', 'd3:mini', 'measuring'),
      target('llama-vulkan', 'd3-mini-q4', 'pending'),
      target('llama-vulkan', 'd3-mini-q8', 'loading'),
    ],
    ...extra,
  });

describe('benchmark card: running', () => {
  it('shows the activity, progress, live rows and locks the actions', () => {
    const card = benchmarkCard(running(), catalog());
    assert.equal(card.stateLabel, 'Running');
    assert.equal(card.activity, 'Timing d3 mini on NPU · long prompts (3,800 tokens)');
    assert.deepEqual(card.progress, {
      completed: 3,
      total: 6,
      fraction: 0.5,
      text: '3 of 6 · about 3 min left',
    });
    assert.equal(card.startedNote, 'Started from the command line.');
    assert.equal(card.primary.kind, 'cancel');
    assert.equal(card.primary.label, 'Cancel benchmark');
    const mini = card.groups.find((g) => g.family === 'f/mini');
    assert.deepEqual(
      mini?.rows.map((r) => r.text),
      ['Measuring…', 'Waiting', 'Loading…'],
    );
    assert.ok(card.groups.every((g) => g.useFastest === null || g.useFastest.disabled));
    assert.equal(card.footer[0], 'Completed results are kept.');
  });

  it('follows the phase, and cancelling disables the button', () => {
    const loading = benchmarkCard(running({ phase: 'loading' }), catalog());
    assert.equal(loading.activity, 'Loading d3 mini on NPU…');
    const cancelling = benchmarkCard(
      running({ state: 'cancelling', phase: 'restoring' }),
      catalog(),
    );
    assert.equal(cancelling.activity, 'Restoring your setup…');
    assert.equal(cancelling.primary.label, 'Cancelling…');
    assert.equal(cancelling.primary.disabled, true);
    assert.equal(cancelling.stateLabel, 'Cancelling');
  });

  it('announces only milestones, not each tick', () => {
    const first = benchmarkCard(running({ etaSeconds: 170 }), catalog());
    const tick = benchmarkCard(running({ etaSeconds: 160 }), catalog());
    const next = benchmarkCard(running({ completed: 4, failed: 1 }), catalog());
    assert.equal(first.announcement, '3 of 6 finished');
    assert.equal(tick.announcement, first.announcement);
    assert.equal(next.announcement, '4 of 6 finished, 1 failed');
    assert.equal(benchmarkCard(running({ completed: 0 }), catalog()).announcement, null);
  });
});

describe('benchmark card: end states', () => {
  it('cancelled by the user keeps results, marks discarded and not-run rows', () => {
    const card = benchmarkCard(
      view({
        state: 'cancelled',
        cancelReason: 'user',
        completed: 3,
        restoredOk: true,
        restore: {
          mode: 'auto',
          engine: 'fastflowlm',
          model: 'd3:lite',
          device: null,
          family: 'f/lite',
        },
        targets: [
          target('llama-vulkan', 'd3-mini-q8', 'discarded'),
          target('strands-decider', 'strands-2b', 'not-run', { device: 'cuda' }),
        ],
      }),
      catalog(),
    );
    assert.equal(
      card.status,
      'Cancelled after 3 of 6. Completed results are kept. Your setup (d3 lite on NPU) is back.',
    );
    assert.equal(card.announcement, card.status);
    assert.equal(card.primary.kind, 'finish');
    assert.equal(card.primary.only, 'missing');
    assert.deepEqual(
      card.secondary.map((a) => a.label),
      ['Run again'],
    );
    const mini = card.groups.find((g) => g.family === 'f/mini');
    const q8 = mini?.rows.find((r) => r.model === 'd3-mini-q8');
    assert.equal(q8?.state, 'cancelled');
    assert.equal(q8?.text, 'Not measured (cancelled)');
    assert.equal(q8?.action?.kind, 'measure');
    assert.equal(card.resultsExpanded, true);
  });

  it('a changed selection cancels without a restore and offers only Finish', () => {
    const card = benchmarkCard(
      view({ state: 'cancelled', cancelReason: 'config-changed' }),
      catalog(),
    );
    assert.equal(
      card.status,
      'Cancelled because the engine selection changed. Completed results are kept.',
    );
    assert.deepEqual(card.secondary, []);
  });

  it('a failed target is a row with Retry for that row alone', () => {
    const card = benchmarkCard(
      view({
        state: 'done',
        completed: 6,
        failed: 1,
        targets: [
          target('llama-vulkan', 'd3-mini-q8', 'failed', { error: 'out of memory\nat load()' }),
        ],
      }),
      catalog(),
    );
    assert.match(card.status ?? '', /^Finished; 1 of 6 failed\./);
    const row = card.groups
      .find((g) => g.family === 'f/mini')
      ?.rows.find((r) => r.model === 'd3-mini-q8');
    assert.equal(row?.state, 'failed');
    assert.equal(row?.text, 'Failed: out of memory');
    assert.equal(row?.error, 'out of memory\nat load()');
    assert.deepEqual(row?.action?.targets, [
      { engine: 'llama-vulkan', model: 'd3-mini-q8', device: null },
    ]);
    assert.equal(row?.action?.label, 'Retry');
    assert.ok(row?.badges.some((b) => b.kind === 'failed'));
    const stored = card.groups
      .find((g) => g.family === 's/2b')
      ?.rows.find((r) => r.device === 'cuda');
    assert.equal(stored?.text, 'Failed: out of memory');
  });

  it('a failed job explains why and keeps results', () => {
    const card = benchmarkCard(view({ state: 'failed', error: 'gateway restarted' }), catalog());
    assert.equal(
      card.status,
      'The benchmark stopped: gateway restarted. Completed results are kept.',
    );
    assert.equal(card.primary.label, 'Run again');
  });

  it('reports a restore failure with its actions', () => {
    const card = benchmarkCard(
      view({
        state: 'done',
        restoredOk: false,
        restoreError: 'engine would not start',
        restore: {
          mode: 'manual',
          engine: 'fastflowlm',
          model: 'd3:lite',
          device: null,
          family: 'f/lite',
        },
      }),
      catalog(),
    );
    assert.equal(
      card.restoreFailure?.text,
      "Couldn't switch back to d3 lite on NPU: engine would not start. Decisions are passed to you until an engine is running.",
    );
    assert.equal(card.restoreFailure?.retry.kind, 'restore');
    assert.deepEqual(card.restoreFailure?.retry.targets, [
      { engine: 'fastflowlm', model: 'd3:lite', device: null },
    ]);
    assert.equal(card.restoreFailure?.auto.label, 'Use automatic');
    assert.doesNotMatch(card.status ?? '', /is back/);
  });
});

describe('benchmark card: results', () => {
  it('groups by family, current first then fastest first, with Fastest here', () => {
    const done = view({
      state: 'done',
      completed: 6,
      restoredOk: true,
      restore: {
        mode: 'auto',
        engine: 'fastflowlm',
        model: 'd3:lite',
        device: null,
        family: 'f/lite',
      },
      targets: [
        {
          ...target('fastflowlm', 'd3:nano', 'done', { family: 'f/nano' }),
          sizes: [
            {
              targetTokens: 256,
              inputTokens: 300,
              p50Ms: 340,
              p95Ms: 360,
              answer: 'done',
              error: null,
            },
            {
              targetTokens: 1024,
              inputTokens: 1000,
              p50Ms: 760,
              p95Ms: 800,
              answer: 'done',
              error: null,
            },
            {
              targetTokens: 3800,
              inputTokens: 3700,
              p50Ms: 2400,
              p95Ms: 2500,
              answer: 'done',
              error: null,
            },
          ],
        },
      ],
    });
    const card = benchmarkCard(done, catalog());
    assert.deepEqual(
      card.groups.map((g) => g.label),
      ['d3 lite', 'd3 nano', 'd3 mini', 'Strands 2B'],
    );
    assert.equal(card.status?.startsWith('Finished. Fastest here: d3 nano on NPU (760 ms).'), true);
    const liteGroup = card.groups[0];
    assert.equal(liteGroup?.current, true);
    assert.deepEqual(
      liteGroup?.rows.map((r) => [r.runtime, r.format, r.typical, r.long, r.p256]),
      [
        ['NPU', 'NPU (FLM)', '520 ms', '1.6 s', '260 ms'],
        ['GPU (Vulkan)', '4-bit Q4_K_M', '460 ms', '1.4 s', '230 ms'],
      ],
    );
    assert.deepEqual(
      liteGroup?.rows[0]?.badges.map((b) => b.label),
      ['Fastest here', 'In use'],
    );
    assert.deepEqual(
      liteGroup?.rows[1]?.badges.map((b) => b.label),
      ['Noisy'],
    );
    const mini = card.groups.find((g) => g.family === 'f/mini');
    assert.equal(mini?.rows[0]?.badges[0]?.label, 'Fastest here');
    assert.equal(mini?.rows[0]?.runtime, 'NPU');
    assert.equal(mini?.rows.at(-1)?.text, 'Speed not measured yet');
    assert.equal(mini?.rows.at(-1)?.action?.label, 'Measure');
    assert.equal(card.showK2, false);
    assert.match(
      liteGroup?.rows[0]?.accessibleName ?? '',
      /^d3 lite on NPU, NPU \(FLM\) format, 256 tokens 260 ms, typical 520 ms, long prompts 1\.6 s, fastest here, in use$/,
    );
  });

  it('offers Use fastest by mode, and Use for a single-runtime family', () => {
    const auto = benchmarkCard(view({ state: 'done' }), catalog());
    const mini = auto.groups.find((g) => g.family === 'f/mini');
    assert.equal(mini?.useFastest?.kind, 'auto');
    assert.equal(mini?.useFastest?.family, 'f/mini');
    assert.equal(mini?.useFastest?.label, 'Use fastest: NPU');
    assert.equal(auto.groups.find((g) => g.family === 'f/nano')?.useFastest?.label, 'Use: NPU');
    const manual = benchmarkCard(
      view({ state: 'done' }),
      catalog(MODELS, { selectionMode: 'manual' }),
    );
    const pick = manual.groups.find((g) => g.family === 'f/mini')?.useFastest;
    assert.equal(pick?.kind, 'use');
    assert.deepEqual(pick?.targets, [{ engine: 'fastflowlm', model: 'd3:mini', device: null }]);
    // The family already running on its fastest runtime has nothing to switch.
    assert.equal(manual.groups[0]?.useFastest, null);
  });

  it('shows a 2k column only when something was measured at 2,048 tokens', () => {
    const withK2 = lite(
      measured(520, 555, {
        sizes: [{ targetTokens: 2048, inputTokens: 2000, p50Ms: 900, p95Ms: 950 }],
      }),
      measured(460, 500),
    );
    const card = benchmarkCard(view(), catalog(withK2));
    assert.equal(card.showK2, true);
    assert.equal(card.groups[0]?.rows[0]?.k2, '900 ms');
    assert.equal(card.groups[0]?.rows[1]?.k2, null);
  });
});
