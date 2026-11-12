import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEngineCatalog, type EngineCatalog } from '../shared/engines.ts';
import { recommendedCard } from '../shared/recommended-card.ts';

const NOON = '2026-11-12T12:00:00.000Z';

type Obj = Record<string, unknown>;

function measured(p50: number, p95: number, extra: Obj = {}): Obj {
  return {
    device: null,
    typical: { p50Ms: p50, p95Ms: p95 },
    long: { p50Ms: 1550, p95Ms: 1991 },
    sizes: [],
    runs: 5,
    provisional: false,
    measuredAt: NOON,
    freshness: 'fresh',
    staleReason: null,
    failed: null,
    ...extra,
  };
}

function option(engine: string, backend: string, m: unknown, extra: Obj = {}): Obj {
  return {
    engine,
    model: engine === 'fastflowlm' ? 'd3:mini' : 'd3-mini-q4_k_m',
    device: null,
    backend,
    code: 'available',
    eligible: true,
    supported: true,
    ready: true,
    reason: '',
    family: 'vllm-sr/d3-mini',
    quant: null,
    downloaded: true,
    calibrated: true,
    active: false,
    measured: m,
    failed: null,
    ...extra,
  };
}

/** Plan §3.3 case 4: d3 mini, NPU 1,687 ms against Vulkan 2,307 ms (ratio 1.37). */
const NPU = option('fastflowlm', 'NPU', measured(1687, 1900));
const VULKAN = option('llama-vulkan', 'Vulkan', measured(2307, 2500));

function group(pick: Obj): Obj {
  return { engine: pick['engine'], device: null, backend: pick['backend'], pick, variants: [pick] };
}

function machine(extra: Obj = {}): Obj {
  return {
    family: 'vllm-sr/d3-mini',
    familyLabel: 'd3 mini',
    source: 'preferred',
    availability: 'ok',
    best: NPU,
    runnerUp: VULKAN,
    ratio: 1.37,
    reason: 'fastest-measured',
    action: 'none',
    partial: false,
    stale: false,
    staleReason: null,
    runtimes: [group(NPU), group(VULKAN)],
    fasterFamily: null,
    ...extra,
  };
}

function catalog(opts: {
  machine?: unknown;
  active?: Obj;
  engines?: Obj[];
  candidates?: unknown[];
  models?: unknown[];
}): EngineCatalog {
  return parseEngineCatalog({
    active: {
      engine: 'fastflowlm',
      model: 'd3:mini',
      state: 'ready',
      selectionMode: 'auto',
      ...opts.active,
    },
    engines: opts.engines ?? [
      { id: 'fastflowlm', label: 'FastFlowLM', installed: true },
      { id: 'llama-vulkan', label: 'llama.cpp (Vulkan)', installed: true },
    ],
    models: opts.models ?? [
      { id: 'd3:mini', engine: 'fastflowlm', label: 'd3 mini', downloadGb: 2.5 },
    ],
    recommendation: {
      candidates: opts.candidates ?? [],
      machine: 'machine' in opts ? opts.machine : machine(),
    },
  });
}

describe('recommendedCard kinds', () => {
  it('ok-auto: d3 mini on the NPU, 37% faster than Vulkan', () => {
    const card = recommendedCard(catalog({}), 'auto');
    assert.equal(card.kind, 'ok-auto');
    assert.equal(card.mode, 'Automatic');
    assert.equal(card.headline, 'd3 mini on NPU');
    assert.equal(card.latency, '1.7 s per decision · 1.6 s on long prompts');
    assert.equal(card.reasonText, 'Measured 12 Nov. 37% faster than GPU (Vulkan).');
    assert.equal(card.status, "You're on the recommended setup.");
    assert.equal(card.primary.kind, 'none');
    assert.deepEqual(
      card.secondary.map((a) => a.label),
      ['Run benchmark again', 'Choose another…'],
    );
    assert.deepEqual(card.badges, []);
    assert.equal(card.overlay, null);
  });

  it('ok-auto also covers a transient use while auto moves', () => {
    const card = recommendedCard(catalog({ machine: machine({ action: 'use' }) }), 'auto');
    assert.equal(card.kind, 'ok-auto');
  });

  it('ok-manual offers automatic and another choice', () => {
    const card = recommendedCard(catalog({ active: { selectionMode: 'manual' } }), 'manual');
    assert.equal(card.kind, 'ok-manual');
    assert.equal(card.mode, 'Manual');
    assert.deepEqual(
      card.secondary.map((a) => [a.kind, a.label]),
      [
        ['auto', 'Use automatic'],
        ['choose', 'Choose another…'],
      ],
    );
    assert.equal(card.secondary[0]?.family, 'vllm-sr/d3-mini');
  });

  it('manual-differs: names the speed-up and offers Use', () => {
    const picked = { ...VULKAN, active: true };
    const card = recommendedCard(
      catalog({
        active: { engine: 'llama-vulkan', model: 'd3-mini-q4_k_m', selectionMode: 'manual' },
        machine: machine({ action: 'use', runtimes: [group(NPU), group(picked)] }),
      }),
      'manual',
    );
    assert.equal(card.kind, 'manual-differs');
    assert.equal(
      card.status,
      'You picked d3 mini on GPU (Vulkan) manually. NPU is 37% faster here.',
    );
    assert.equal(card.primary.kind, 'use');
    assert.equal(card.primary.label, 'Use NPU');
    assert.deepEqual(card.primary.target, { engine: 'fastflowlm', model: 'd3:mini', device: null });
    assert.equal(card.secondary[0]?.kind, 'auto');
  });

  it('manual-differs without a measurement says usually faster', () => {
    const card = recommendedCard(
      catalog({
        active: { engine: 'llama-vulkan', model: 'x', selectionMode: 'manual' },
        machine: machine({ action: 'use' }),
      }),
      'manual',
    );
    assert.match(card.status, /NPU is usually faster on this kind of hardware\.$/);
  });

  it('estimated: Run benchmark, or Use when the best can be used', () => {
    const est = machine({ reason: 'estimated', best: { ...NPU, measured: null }, ratio: null });
    const card = recommendedCard(catalog({ machine: est }), 'auto');
    assert.equal(card.kind, 'estimated');
    assert.equal(card.latency, 'Speed not measured yet');
    assert.equal(
      card.reasonText,
      'Speed not measured yet. NPU is usually fastest on this kind of hardware.',
    );
    assert.equal(card.primary.kind, 'benchmark');
    assert.equal(card.primary.label, 'Run benchmark');
    const use = recommendedCard(catalog({ machine: { ...est, action: 'use' } }), 'auto');
    assert.equal(use.kind, 'estimated');
    assert.equal(use.primary.kind, 'use');
    assert.equal(use.primary.label, 'Use NPU (turns off automatic)');
    assert.equal(use.secondary[0]?.label, 'Run benchmark');
  });

  it('needs-download shows the size and offers automatic in manual mode only', () => {
    const m = machine({ action: 'download' });
    const auto = recommendedCard(catalog({ machine: m }), 'auto');
    assert.equal(auto.kind, 'needs-download');
    assert.equal(auto.status, "d3 mini for NPU isn't downloaded yet (2.5 GB).");
    assert.equal(auto.primary.kind, 'download');
    assert.equal(auto.primary.label, 'Download (2.5 GB)');
    assert.deepEqual(auto.secondary, []);
    const manual = recommendedCard(catalog({ machine: m }), 'manual');
    assert.deepEqual(
      manual.secondary.map((a) => a.kind),
      ['auto'],
    );
  });

  it('needs-install offers install steps and the next installed option', () => {
    const missing = { ...NPU, ready: false, downloaded: false };
    const card = recommendedCard(
      catalog({
        machine: machine({
          action: 'install',
          best: missing,
          runtimes: [group(missing), group(VULKAN)],
        }),
      }),
      'auto',
    );
    assert.equal(card.kind, 'needs-install');
    assert.equal(
      card.status,
      "NPU needs FastFlowLM, which isn't installed on the gateway machine.",
    );
    assert.equal(card.primary.kind, 'install');
    assert.equal(card.primary.label, 'Show install steps');
    assert.equal(card.secondary[0]?.label, 'Use GPU (Vulkan) for now (turns off automatic)');
    assert.equal(card.secondary[0]?.target?.engine, 'llama-vulkan');
  });

  it('fallback: a failed runtime in automatic mode', () => {
    const card = recommendedCard(
      catalog({
        active: {
          engine: 'llama-vulkan',
          model: 'd3-mini-q4_k_m',
          fallback: {
            reason: 'load timed out',
            engine: 'fastflowlm',
            retryAt: '2026-11-12T12:02:00.000Z',
          },
        },
      }),
      'auto',
      Date.parse(NOON),
    );
    assert.equal(card.kind, 'fallback');
    assert.equal(
      card.status,
      'NPU failed: load timed out. Running on GPU (Vulkan) for now. Retrying in 2 min.',
    );
    assert.equal(card.primary.kind, 'none');
    assert.equal(card.secondary[0]?.kind, 'details');
  });

  it('fallback: family unavailable', () => {
    const card = recommendedCard(
      catalog({
        machine: machine({ availability: 'family-unavailable', best: null, runtimes: [] }),
      }),
      'auto',
    );
    assert.equal(card.kind, 'fallback');
    assert.equal(card.headline, 'd3 mini');
    assert.equal(card.status, "d3 mini can't run on this machine right now. Running NPU instead.");
    assert.equal(card.secondary[0]?.kind, 'choose');
  });

  it('uncalibrated: an OpenAI-like active engine', () => {
    const card = recommendedCard(
      catalog({
        active: { engine: 'openai-compatible', model: 'gpt-x' },
        engines: [{ id: 'openai-compatible', label: 'My server', calibrated: false }],
        models: [{ id: 'gpt-x', engine: 'openai-compatible', label: 'GPT X' }],
      }),
      'manual',
    );
    assert.equal(card.kind, 'uncalibrated');
    assert.equal(card.headline, 'GPT X on My server');
    assert.equal(card.primary.kind, 'none');
    assert.equal(card.secondary[0]?.label, 'Use automatic');
  });

  it('unsupported: nothing can run and no server is configured', () => {
    const base = { engine: 'e', model: 'm', reason: 'Needs at least 4 GB of free memory.' };
    const card = recommendedCard(
      catalog({
        machine: null,
        active: { engine: null },
        candidates: [
          { ...base, code: 'no-memory' },
          { ...base, code: 'unsupported-platform' },
        ],
      }),
      'auto',
    );
    assert.equal(card.kind, 'unsupported');
    assert.equal(card.headline, 'No local model can run here');
    assert.equal(card.status, 'Needs at least 4 GB of free memory.');
    assert.equal(card.primary.kind, 'connect');
    const connected = recommendedCard(
      catalog({
        machine: null,
        active: { engine: null },
        engines: [
          { id: 'openai-compatible', label: 'S', connection: { url: 'http://x', model: 'm' } },
        ],
        candidates: [{ ...base, code: 'no-memory' }],
      }),
      'auto',
    );
    assert.notEqual(connected.kind, 'unsupported');
  });
});

describe('recommendedCard precedence, overlays and badges', () => {
  it('fallback with a stale record keeps fallback and adds the stale badge', () => {
    const card = recommendedCard(
      catalog({
        active: { fallback: { reason: 'boom', engine: 'fastflowlm' } },
        machine: machine({ stale: true, staleReason: 'driver changed' }),
      }),
      'auto',
    );
    assert.equal(card.kind, 'fallback');
    assert.deepEqual(card.badges, [{ kind: 'stale', label: 'Out of date' }]);
    assert.equal(
      card.note,
      'Out of date — run again. driver changed. Not used for ranking until measured again.',
    );
    assert.ok(card.secondary.some((a) => a.label === 'Run benchmark again'));
  });

  it('needs-download with partial keeps needs-download and adds the partial badge', () => {
    const card = recommendedCard(
      catalog({ machine: machine({ action: 'download', partial: true }) }),
      'auto',
    );
    assert.equal(card.kind, 'needs-download');
    assert.deepEqual(card.badges, [{ kind: 'partial', label: 'Partly measured' }]);
    assert.equal(card.note, "Other runtimes here weren't measured.");
    const finish = card.secondary.find((a) => a.kind === 'finish-benchmark');
    assert.equal(finish?.label, 'Finish benchmark');
  });

  it('benchmarking overlays ok-auto, disables actions and beats switching', () => {
    const card = recommendedCard(
      catalog({ active: { benchmark: { completed: 3, total: 6 }, state: 'starting' } }),
      'auto',
    );
    assert.equal(card.kind, 'ok-auto');
    assert.equal(card.overlay, 'benchmarking');
    assert.equal(
      card.overlayText,
      'Benchmark running (3 of 6). Decisions are passed to you until it finishes.',
    );
    assert.equal(card.overlayLink, 'Go to benchmark');
    assert.ok(
      card.secondary.every((a) => a.disabled && a.hint === 'Available when this finishes.'),
    );
  });

  it('switching overlay when the engine is starting', () => {
    const card = recommendedCard(catalog({ active: { state: 'starting' } }), 'auto');
    assert.equal(card.overlay, 'switching');
    assert.equal(
      card.overlayText,
      "Switching to d3 mini on NPU. Decisions are passed to you until it's ready.",
    );
    assert.equal(card.overlayLink, null);
  });

  it('badges come in order; p95 over twice p50 is noisy', () => {
    const noisy = option(
      'llama-vulkan',
      'Vulkan',
      measured(470, 1000, { provisional: true, runs: 2 }),
    );
    const card = recommendedCard(
      catalog({ machine: machine({ best: noisy, stale: true }) }),
      'auto',
    );
    assert.deepEqual(
      card.badges.map((b) => b.label),
      ['Out of date', 'Few runs', 'Noisy'],
    );
    assert.equal(card.note?.startsWith('Out of date'), true);
  });

  it('d3 lite NPU 520/555 against Vulkan 470/529 is a tie, and not noisy', () => {
    const npu = option('fastflowlm', 'NPU', measured(520, 555));
    const vk = option('llama-vulkan', 'Vulkan', measured(470, 529));
    const card = recommendedCard(
      catalog({
        machine: machine({
          familyLabel: 'd3 lite',
          best: npu,
          runnerUp: vk,
          ratio: null,
          reason: 'tie-dedicated',
        }),
      }),
      'auto',
    );
    assert.equal(card.headline, 'd3 lite on NPU');
    assert.equal(card.latency, '520 ms per decision · 1.6 s on long prompts');
    assert.equal(
      card.reasonText,
      'Measured 12 Nov. About the same as GPU (Vulkan); the NPU is steadier and leaves your GPU free.',
    );
    assert.deepEqual(card.badges, []);
  });

  it('writes a reason per code, and a faster-family sentence', () => {
    const reasonFor = (reason: string, extra: Obj = {}): string | null =>
      recommendedCard(catalog({ machine: machine({ reason, ...extra }) }), 'auto').reasonText;
    assert.equal(
      reasonFor('tie-steadier'),
      'Measured 12 Nov. About the same as GPU (Vulkan); NPU is steadier.',
    );
    assert.equal(reasonFor('tie-ladder'), 'About the same as GPU (Vulkan).');
    assert.equal(
      reasonFor('only-measured'),
      "Measured 12 Nov. Other runtimes here weren't measured.",
    );
    assert.equal(reasonFor('only-option'), 'd3 mini runs only on NPU here.');
    assert.equal(
      reasonFor('fastest-measured', { ratio: 2.34 }),
      'Measured 12 Nov. 2.3× faster than GPU (Vulkan).',
    );
    assert.equal(reasonFor('x'), null);
    const faster = recommendedCard(
      catalog({
        machine: machine({
          fasterFamily: { family: 'vllm-sr/d3-lite', label: 'd3 lite', best: NPU, ratio: 3.04 },
        }),
      }),
      'auto',
    );
    assert.equal(faster.fasterFamilyText, 'd3 lite is about 3× faster on this machine.');
  });

  it('degrades to a plain card on an old gateway', () => {
    const card = recommendedCard(
      parseEngineCatalog({ active: { engine: 'fastflowlm', selectionMode: 'manual' } }),
    );
    assert.equal(card.kind, 'ok-manual');
    assert.equal(card.latency, null);
    assert.equal(card.reasonText, null);
  });
});
