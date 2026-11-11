import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEngineCatalog } from '../shared/engines.ts';
import {
  fallbackText,
  parseRecommendation,
  recommendationView,
  selectionModeLabel,
} from '../shared/recommendation.ts';

const RECOMMENDATION = {
  recommended: {
    engine: 'fastflowlm',
    model: 'd3:mini',
    device: null,
    reason: 'AMD NPU found',
    explicit: false,
  },
  candidates: [
    {
      engine: 'fastflowlm',
      model: 'd3:mini',
      device: null,
      backend: 'NPU',
      eligible: true,
      ready: true,
      reason: 'AMD NPU found',
    },
    {
      engine: 'strands-decider',
      model: 'm',
      device: 'cpu',
      backend: 'CPU',
      eligible: true,
      ready: false,
      reason: 'always works',
    },
    { engine: 'broken' },
  ],
  extra: true,
};

describe('recommendation parsing', () => {
  it('reads the gateway recommendation and skips malformed candidates', () => {
    const rec = parseRecommendation(RECOMMENDATION);
    assert.equal(rec?.recommended?.model, 'd3:mini');
    assert.equal(rec?.candidates.length, 2);
    assert.equal(rec?.candidates[1]?.ready, false);
  });

  it('renders a catalog from an older gateway without these fields', () => {
    const catalog = parseEngineCatalog({ active: { engine: 'fastflowlm', model: 'm' } });
    assert.equal(catalog.recommendation, null);
    assert.equal(catalog.active?.selectionMode, null);
    assert.equal(catalog.active?.fallback, null);
    assert.equal(recommendationView(catalog.recommendation), null);
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
    assert.equal(catalog.recommendation?.recommended?.engine, 'fastflowlm');
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
  it('names the pick and each candidate with its state', () => {
    const view = recommendationView(parseRecommendation(RECOMMENDATION));
    assert.equal(view?.headline, 'fastflowlm · d3:mini on NPU');
    assert.deepEqual(
      view?.candidates.map((c) => c.note),
      ['ready · AMD NPU found', 'not installed · always works'],
    );
  });

  it('says so when nothing is eligible', () => {
    const view = recommendationView({
      recommended: null,
      candidates: [
        {
          engine: 'x',
          model: 'm',
          device: null,
          backend: null,
          eligible: false,
          ready: false,
          reason: 'uncalibrated',
        },
      ],
    });
    assert.match(view?.headline ?? '', /No engine is eligible/);
    assert.equal(view?.candidates[0]?.note, 'not eligible · uncalibrated');
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
