import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  beats,
  CLOSE_CALL,
  familyOrder,
  groupRuntimes,
  machineView,
  pickVariant,
  rankable,
  tournament,
  type MachineOption,
  type Measured,
} from '../src/engines/ranking.ts';

const FAMILY = 'vllm-sr/d3-mini';

function measured(
  p50Ms: number,
  p95Ms = p50Ms,
  extra: Partial<Measured> = {},
): Measured {
  return {
    typical: { p50Ms, p95Ms },
    long: null,
    runs: 5,
    measuredAt: '2026-11-12T00:00:00.000Z',
    freshness: 'fresh',
    staleReason: null,
    provisional: false,
    ...extra,
  };
}

function option(overrides: Partial<MachineOption> = {}): MachineOption {
  return {
    engine: 'fastflowlm',
    device: null,
    backend: 'NPU',
    model: 'd3:mini',
    eligible: true,
    supported: true,
    ready: true,
    reason: 'available',
    code: 'available',
    family: FAMILY,
    quant: 'FLM',
    downloaded: true,
    calibrated: true,
    active: false,
    measured: null,
    failed: null,
    recommended: false,
    ...overrides,
  };
}

describe('machine ranking', () => {
  it('ranks only fresh, non-provisional measurements', () => {
    assert.equal(rankable(measured(10)), true);
    assert.equal(rankable(measured(10, 10, { freshness: 'stale' })), false);
    assert.equal(rankable(measured(10, 10, { provisional: true })), false);
  });

  it('compares fastest, dedicated, steadier and ladder-tied options', () => {
    const incumbent = option({ measured: measured(100, 200) });
    assert.deepEqual(beats(option({ measured: measured(80) }), incumbent), {
      wins: true,
      reason: 'fastest-measured',
    });
    assert.deepEqual(
      beats(option({ backend: 'Vulkan', measured: measured(100, 200) }),
        option({ backend: 'NPU', measured: measured(105, 205) })),
      { wins: false, reason: 'tie-dedicated' },
    );
    assert.deepEqual(
      beats(option({ backend: 'CPU', measured: measured(100, 100) }),
        option({ backend: 'CPU', measured: measured(100, 200) })),
      { wins: true, reason: 'tie-steadier' },
    );
    assert.deepEqual(
      beats(option({ backend: 'CPU', measured: measured(100) }),
        option({ backend: 'CPU', measured: measured(100) })),
      { wins: false, reason: 'tie-ladder' },
    );
    assert.equal(CLOSE_CALL, 0.1);
  });

  it('uses deterministic tournament ordering and keeps unmeasured ladder slots', () => {
    const ladder = [
      option({ engine: 'fastflowlm', measured: measured(70, 80, { freshness: 'stale' }) }),
      option({ engine: 'llama-vulkan', backend: 'Vulkan', measured: measured(120) }),
      option({ engine: 'strands-decider', backend: 'CPU', measured: measured(10, 10, { provisional: true }) }),
    ];
    const groups = groupRuntimes(ladder);
    assert.deepEqual(familyOrder(ladder).ranked.map(({ engine }) => engine), [
      'fastflowlm',
      'llama-vulkan',
      'strands-decider',
    ]);
    assert.deepEqual(
      tournament(groups.filter((group) => rankable(group.pick.measured))).map(({ engine }) => engine),
      ['llama-vulkan'],
    );
  });

  it('moves the latest failed runtime after successful choices', () => {
    const options = [
      option({ engine: 'fastflowlm', failed: { error: 'load failed', at: 'then' } }),
      option({ engine: 'llama-vulkan', backend: 'Vulkan', measured: measured(100) }),
    ];
    assert.deepEqual(familyOrder(options).ranked.map(({ engine }) => engine), ['llama-vulkan']);
    assert.deepEqual(familyOrder(options).failed.map(({ engine }) => engine), ['fastflowlm']);
  });

  it('chooses the faster quant inside one runtime and reports only-option', () => {
    const variants = [
      option({ model: 'd3-mini-q4_k_m', engine: 'llama-vulkan', backend: 'Vulkan', quant: 'Q4_K_M', recommended: true, measured: measured(140) }),
      option({ model: 'd3-mini-q8_0', engine: 'llama-vulkan', backend: 'Vulkan', quant: 'Q8_0', measured: measured(100) }),
    ];
    assert.equal(pickVariant(variants).model, 'd3-mini-q8_0');
    const view = machineView(FAMILY, 'default', variants);
    assert.equal(view.reason, 'only-option');
    assert.equal(view.best?.model, 'd3-mini-q8_0');
    const unmeasured = variants.map((variant) => ({ ...variant, measured: null }));
    assert.equal(pickVariant(unmeasured).model, 'd3-mini-q4_k_m');
  });

  it('reports estimated, only-measured, readiness actions and faster families', () => {
    const unmeasured = machineView(FAMILY, 'default', [option()]);
    assert.equal(unmeasured.reason, 'only-option');
    assert.equal(unmeasured.best?.measured, null);
    const two = [
      option({ engine: 'fastflowlm', measured: null, ready: true }),
      option({ engine: 'llama-vulkan', backend: 'Vulkan', measured: measured(100), ready: false }),
    ];
    const estimated = machineView(FAMILY, 'preferred', [
      { ...two[0]!, active: true },
      two[1]!,
    ]);
    assert.equal(estimated.reason, 'estimated');
    assert.equal(estimated.action, 'none');
    const onlyMeasured = machineView(FAMILY, 'preferred', [
      option({ engine: 'fastflowlm', measured: measured(100), active: true }),
      option({ engine: 'llama-vulkan', backend: 'Vulkan', ready: false }),
    ]);
    assert.equal(onlyMeasured.reason, 'only-measured');
    assert.equal(onlyMeasured.action, 'none');

    const unready = machineView(FAMILY, 'default', [option({ ready: false })]);
    assert.equal(unready.action, 'install');
    const notDownloaded = machineView(FAMILY, 'default', [option({ downloaded: false })]);
    assert.equal(notDownloaded.action, 'download');
    const inactive = machineView(FAMILY, 'default', [option({ active: false })]);
    assert.equal(inactive.action, 'use');

    const fasterFamily = option({ family: 'other-family', measured: measured(50) });
    const compared = machineView(FAMILY, 'default', [option({ measured: measured(100) })], [
      option({ measured: measured(100) }),
      fasterFamily,
    ]);
    assert.equal(compared.fasterFamily?.family, 'other-family');
    assert.equal(compared.fasterFamily?.ratio, 2);
  });
});
