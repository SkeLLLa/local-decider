import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEngineCatalog } from '../shared/engines.ts';
import {
  fallbackText,
  parseRecommendation,
  recommendationView,
  selectionModeLabel,
} from '../shared/recommendation.ts';

const TARGET = {
  engine: 'strands-decider',
  model: 'm',
  device: 'mlx',
  reason: 'MLX/Metal: MLX with Metal',
};

const cand = (over: Record<string, unknown>): Record<string, unknown> => ({
  engine: 'strands-decider',
  model: 'm',
  device: 'mlx',
  backend: 'MLX',
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
    cand({ device: 'cpu', backend: 'CPU', ready: false, reason: 'always available' }),
    cand({
      engine: 'fastflowlm',
      model: 'd3:mini',
      device: null,
      backend: 'NPU',
      eligible: false,
      supported: false,
      reason: 'supported only on Linux',
    }),
    { engine: 'broken' },
  ],
  extra: true,
};

const LABELS = new Map([
  ['strands-decider', 'Strands Decider'],
  ['fastflowlm', 'FastFlowLM'],
]);

describe('recommendation parsing', () => {
  it('reads the gateway recommendation and skips malformed candidates', () => {
    const rec = parseRecommendation(RECOMMENDATION);
    assert.equal(rec?.automatic?.engine, 'strands-decider');
    assert.equal(rec?.candidates.length, 3);
    assert.equal(rec?.candidates[1]?.ready, false);
  });

  it('renders a catalog from an older gateway without these fields', () => {
    const catalog = parseEngineCatalog({ active: { engine: 'fastflowlm', model: 'm' } });
    assert.equal(catalog.recommendation, null);
    assert.equal(catalog.active?.selectionMode, null);
    assert.equal(catalog.active?.fallback, null);
    assert.equal(recommendationView(catalog.recommendation, null, LABELS), null);
    assert.equal(selectionModeLabel(catalog.active?.selectionMode ?? null), null);
  });

  it('keeps the recommendation apart from the active selection', () => {
    const catalog = parseEngineCatalog({
      active: {
        engine: 'strands-decider',
        model: 'm',
        selectionMode: 'auto',
        fallback: { reason: 'fastflowlm failed: boom', retryAt: '2026-01-01T00:00:30.000Z' },
      },
      recommendation: RECOMMENDATION,
    });
    assert.equal(catalog.active?.engine, 'strands-decider');
    assert.equal(catalog.recommendation?.recommended?.engine, 'strands-decider');
    assert.equal(catalog.active?.selectionMode, 'auto');
    assert.equal(catalog.active?.fallback?.reason, 'fastflowlm failed: boom');
  });

  it('ignores an unknown selection mode and a fallback without a reason', () => {
    const catalog = parseEngineCatalog({
      active: { selectionMode: 'sometimes', fallback: { retryAt: 'x' } },
    });
    assert.equal(catalog.active?.selectionMode, null);
    assert.equal(catalog.active?.fallback, null);
  });
});

describe('recommendation view', () => {
  const parsed = parseRecommendation(RECOMMENDATION);

  it('summarises the pick in a short value and lists supported candidates only', () => {
    const view = recommendationView(parsed, 'auto', LABELS);
    assert.deepEqual(view?.summary, {
      label: 'Recommended',
      value: 'Strands Decider · Apple MLX',
      reason: 'MLX/Metal: MLX with Metal',
    });
    assert.deepEqual(
      view?.candidates.map((c) => [c.label, c.status]),
      [
        ['Strands Decider · Apple MLX', 'Ready'],
        ['Strands Decider · CPU', 'Not installed'],
      ],
    );
  });

  it('in manual mode shows what automatic would pick, not the explicit echo', () => {
    const rec = parseRecommendation({
      ...RECOMMENDATION,
      recommended: { ...TARGET, device: 'cpu', reason: 'explicit selection', explicit: true },
    });
    const view = recommendationView(rec, 'manual', LABELS);
    assert.equal(view?.summary.label, 'Automatic would pick');
    assert.equal(view?.summary.value, 'Strands Decider · Apple MLX');
  });

  it('says the selection matches when automatic would pick the same engine', () => {
    const rec = parseRecommendation({
      ...RECOMMENDATION,
      recommended: { ...TARGET, reason: 'explicit selection', explicit: true },
    });
    assert.equal(
      recommendationView(rec, 'manual', LABELS)?.summary.value,
      'Matches your selection',
    );
  });

  it('treats a candidate without `supported` as supported and names model-only engines', () => {
    const rec = parseRecommendation({
      recommended: null,
      candidates: [
        {
          engine: 'lmstudio',
          model: 'qwen3-4b-instruct-2507',
          device: null,
          backend: null,
          eligible: false,
          ready: true,
          reason: 'uncalibrated: explicit choice only',
        },
      ],
    });
    const view = recommendationView(rec, 'auto', new Map([['lmstudio', 'LM Studio']]));
    assert.equal(view?.candidates[0]?.label, 'LM Studio · qwen3-4b-instruct-2507');
    assert.equal(view?.candidates[0]?.status, 'Not eligible');
    assert.equal(view?.summary.value, 'None eligible');
  });

  it('labels the selection mode and the fallback countdown', () => {
    assert.equal(selectionModeLabel('auto'), 'Automatic');
    assert.equal(selectionModeLabel('manual'), 'Manual');
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    assert.equal(
      fallbackText({ reason: 'x failed', retryAt: '2026-01-01T00:00:30.000Z' }, now),
      'x failed; retry in 30 s',
    );
    assert.equal(fallbackText({ reason: 'x failed', retryAt: null }, now), 'x failed');
    assert.equal(fallbackText(null, now), null);
  });
});
