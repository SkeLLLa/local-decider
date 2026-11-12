import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEngineCatalog } from '../shared/engines.ts';
import {
  AUTO_ENGINE,
  LEAVES_AUTO_HINT,
  USE_AUTO_HINT,
  autoHint,
  backendName,
  engineWhere,
  enginesView,
  fallbackLine,
  installCommand,
  namesOf,
  parseRecommendation,
  runningView,
  type ActiveInfo,
  type Names,
  type Recommendation,
  type Target,
} from '../shared/recommendation.ts';

const TARGET = { engine: 'strands-decider', model: 'm', device: 'mlx', reason: 'fastest here' };

const cand = (over: Record<string, unknown>): Record<string, unknown> => ({
  engine: 'strands-decider',
  model: 'm',
  device: 'mlx',
  backend: 'MLX',
  code: 'available',
  eligible: true,
  supported: true,
  ready: true,
  reason: 'MLX/Metal: MLX with Metal',
  ...over,
});

const RECOMMENDATION = {
  recommended: { ...TARGET, explicit: false },
  automatic: { ...TARGET, explicit: false },
  candidates: [
    cand({}),
    cand({ device: 'mps', backend: 'MPS' }),
    cand({ device: 'cpu', backend: 'CPU' }),
    cand({
      engine: 'lmstudio',
      model: 'qwen3-4b-instruct-2507',
      device: null,
      backend: null,
      code: 'uncalibrated',
      eligible: false,
    }),
    cand({
      engine: 'fastflowlm',
      model: 'd3:mini',
      device: null,
      backend: 'NPU',
      code: 'unsupported-platform',
      eligible: false,
      supported: false,
    }),
    cand({ device: 'cuda', backend: 'CUDA', code: 'no-hardware', eligible: false }),
    { engine: 'broken' },
  ],
  extra: true,
};

const NAMES: Names = namesOf({
  engines: [
    { id: 'strands-decider', label: 'Strands Decider' },
    { id: 'fastflowlm', label: 'FastFlowLM' },
    { id: 'lmstudio', label: 'LM Studio' },
  ],
  models: [
    { engine: 'strands-decider', id: 'm', label: 'strands-decider 2B', latencyHint: '~66 ms' },
    {
      engine: 'lmstudio',
      id: 'qwen3-4b-instruct-2507',
      label: 'Qwen3 4B',
      latencyHint: '~1.1 s CPU, ~180 ms MPS, ~66 ms MLX (M5 Pro, a long note)',
    },
  ],
});

const rec = (over: Record<string, unknown> = {}): Recommendation | null =>
  parseRecommendation({ ...RECOMMENDATION, ...over });

const active = (over: Partial<ActiveInfo> = {}): ActiveInfo => ({
  engine: 'strands-decider',
  model: 'm',
  device: 'auto',
  resolvedDevice: 'mlx',
  backend: 'MLX',
  state: 'ready',
  selectionMode: 'manual',
  fallback: null,
  ...over,
});

describe('recommendation parsing', () => {
  it('reads the gateway recommendation, codes included, and skips malformed candidates', () => {
    const parsed = rec();
    assert.equal(parsed?.automatic?.engine, 'strands-decider');
    assert.equal(parsed?.candidates.length, 6);
    assert.equal(parsed?.candidates[3]?.code, 'uncalibrated');
  });

  it('renders a catalog from an older gateway without these fields', () => {
    const catalog = parseEngineCatalog({ active: { engine: 'fastflowlm', model: 'm' } });
    assert.equal(catalog.recommendation, null);
    assert.equal(catalog.active?.selectionMode, null);
    assert.equal(catalog.active?.fallback, null);
    assert.equal(enginesView(catalog.recommendation, NAMES), null);
    assert.equal(fallbackLine(catalog.active, NAMES), null);
  });

  it('reads backend, resolved device and the failed engine of a fallback', () => {
    const catalog = parseEngineCatalog({
      active: {
        engine: 'strands-decider',
        model: 'm',
        resolvedDevice: 'cpu',
        backend: 'CPU',
        selectionMode: 'auto',
        fallback: { reason: 'x failed', engine: 'fastflowlm', retryAt: '2026-01-01T00:00:30.000Z' },
      },
    });
    assert.equal(catalog.active?.backend, 'CPU');
    assert.equal(catalog.active?.resolvedDevice, 'cpu');
    assert.equal(catalog.active?.fallback?.engine, 'fastflowlm');
  });

  it('ignores unknown codes, an unknown mode and a fallback without a reason', () => {
    const parsed = rec({ candidates: [cand({ code: 'bogus' })] });
    assert.equal(parsed?.candidates[0]?.code, null);
    const catalog = parseEngineCatalog({
      active: { selectionMode: 'sometimes', fallback: { retryAt: 'x' } },
    });
    assert.equal(catalog.active?.selectionMode, null);
    assert.equal(catalog.active?.fallback, null);
  });
});

describe('current engine', () => {
  it('names the running engine and shows a short model and a state badge', () => {
    assert.deepEqual(runningView(active(), NAMES), {
      value: 'Strands Decider · Apple GPU (MLX)',
      hint: 'strands-decider 2B · ~66 ms',
      state: { text: 'Ready', tone: 'success' },
    });
  });

  it('drops long latency notes and raw model ids', () => {
    const view = runningView(
      active({
        engine: 'lmstudio',
        model: 'qwen3-4b-instruct-2507',
        backend: null,
        resolvedDevice: null,
        device: null,
      }),
      NAMES,
    );
    assert.equal(view?.value, 'LM Studio');
    assert.equal(view?.hint, 'Qwen3 4B');
    assert.equal(runningView(active({ model: 'unlisted-id' }), NAMES)?.hint, '');
  });

  it('derives the backend from the device on gateways that send no backend', () => {
    const view = runningView(active({ backend: null, resolvedDevice: null, device: 'cpu' }), NAMES);
    assert.equal(view?.value, 'Strands Decider · CPU');
    assert.equal(
      runningView(
        active({ engine: 'fastflowlm', backend: null, device: null, resolvedDevice: null }),
        NAMES,
      )?.value,
      'FastFlowLM · AMD NPU',
    );
  });

  it('maps engine states to badges', () => {
    assert.equal(runningView(active({ state: 'starting' }), NAMES)?.state?.text, 'Loading');
    assert.equal(runningView(active({ state: 'failed' }), NAMES)?.state?.tone, 'error');
    assert.equal(runningView(active({ state: 'weird' }), NAMES)?.state, null);
    assert.equal(runningView(null, NAMES), null);
  });

  it('words the hint for Automatic, with and without a running engine', () => {
    assert.equal(
      autoHint(active({ selectionMode: 'auto' }), NAMES),
      'Now using Strands Decider · Apple GPU (MLX). Falls back to the next engine if it fails.',
    );
    assert.equal(autoHint(null, NAMES), 'Falls back to the next engine if it fails.');
    assert.match(USE_AUTO_HINT, /fastest engine this computer supports/);
    assert.equal(LEAVES_AUTO_HINT, 'Picking an engine turns off automatic selection.');
    assert.equal(AUTO_ENGINE, '__auto__');
  });

  it('words a fallback with the failed backend and minutes', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const at = (
      retryAt: string | null,
      engine: string | null = 'strands-decider',
      device = 'mlx',
    ): string | null =>
      fallbackLine(active({ fallback: { reason: 'x', engine, device, retryAt } }), NAMES, now);
    assert.equal(at('2026-01-01T00:01:30.000Z'), 'Apple GPU (MLX) failed; retrying in 2 min.');
    assert.equal(
      at('2026-01-01T00:00:20.000Z'),
      'Apple GPU (MLX) failed; retrying in under a minute.',
    );
    assert.equal(at(null), 'Apple GPU (MLX) failed; it will be retried.');
    assert.equal(at(null, null), 'The preferred engine failed; it will be retried.');
    assert.equal(at(null, 'fastflowlm', ''), 'AMD NPU failed; it will be retried.');
  });
});

const target = (engine: string, model: string): Target => ({
  engine,
  model,
  device: null,
  reason: '',
  explicit: false,
});

describe('install command', () => {
  it('names the Vulkan backend', () => {
    assert.equal(backendName('Vulkan'), 'GPU (Vulkan)');
  });

  it('words the command per engine', () => {
    assert.equal(
      installCommand(target('llama-vulkan', 'd3-mini-q4_k_m'), 'Vulkan'),
      'local-decider engine install --engine llama-vulkan --model d3-mini-q4_k_m',
    );
    assert.equal(
      installCommand(target('strands-decider', 'm'), 'MLX'),
      'local-decider engine install --flavor mlx',
    );
    assert.equal(
      installCommand(target('fastflowlm', 'd3:mini'), 'NPU'),
      'Install FastFlowLM with your package manager or from https://github.com/FastFlowLM/FastFlowLM, then:\n' +
        'local-decider engine install --engine fastflowlm --model d3:mini',
    );
  });
});

describe('engines on this computer', () => {
  it('hides unsupported engines and absent hardware and explains the rest plainly', () => {
    const view = enginesView(rec(), NAMES);
    assert.equal(view?.summary, '3 ready');
    assert.deepEqual(
      view?.rows.map((r) => [r.label, r.detail]),
      [
        ['Apple GPU (MLX)', 'Ready · fastest'],
        ['Apple GPU (PyTorch MPS)', 'Ready'],
        ['CPU', 'Ready · slowest, works everywhere'],
        ['LM Studio', "Manual only · its confidence isn't calibrated for automatic use"],
      ],
    );
  });

  it('words not installed, not detected and not enough memory', () => {
    const view = enginesView(
      rec({
        candidates: [
          cand({ ready: false }),
          cand({ device: 'mps', backend: 'MPS', code: 'not-confirmed', eligible: false }),
          cand({ device: 'cpu', backend: 'CPU', code: 'no-memory', eligible: false }),
        ],
      }),
      NAMES,
    );
    assert.deepEqual(
      view?.rows.map((r) => r.detail),
      ['Not installed', 'Not detected on this computer', 'Not enough memory'],
    );
    assert.equal(view?.summary, '0 ready');
  });

  it('copes with candidates from an older gateway that send no code', () => {
    const view = enginesView(
      rec({
        candidates: [
          cand({ code: undefined }),
          cand({ code: undefined, device: 'cpu', backend: 'CPU', eligible: false }),
        ],
      }),
      NAMES,
    );
    assert.deepEqual(
      view?.rows.map((r) => r.detail),
      ['Ready', 'Not used automatically'],
    );
    assert.equal(enginesView(null, NAMES), null);
  });

  it('shows a lone CPU as working everywhere and names where each engine runs', () => {
    const only = enginesView(rec({ candidates: [cand({ device: 'cpu', backend: 'CPU' })] }), NAMES);
    assert.equal(only?.rows[0]?.detail, 'Ready · works everywhere');
    assert.equal(engineWhere('strands-decider', active(), rec()), 'Apple GPU (MLX)');
    assert.equal(engineWhere('strands-decider', null, rec()), 'Apple GPU (MLX)');
    assert.equal(engineWhere('lmstudio', null, rec()), null);
    assert.equal(backendName('MPS'), 'Apple GPU (PyTorch MPS)');
    assert.equal(backendName('FUTURE'), 'FUTURE');
  });
});
