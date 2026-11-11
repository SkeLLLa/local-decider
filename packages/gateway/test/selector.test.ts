import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostInfo } from '../src/engines/descriptor.ts';
import type { CapabilityResult, HostCapabilities } from '../src/engines/host-capabilities.ts';
import { ENGINES } from '../src/engines/registry.ts';
import { rankEngines, type Ranking } from '../src/engines/selector.ts';

const NO: CapabilityResult = { status: 'unavailable', evidence: 'none' };
const MAYBE: CapabilityResult = { status: 'unknown', evidence: 'unknown' };
const YES = (variant?: 'mlx' | 'mps'): CapabilityResult => ({
  status: 'available',
  evidence: 'ok',
  ...(variant === undefined ? {} : { variant }),
});

function caps(over: Partial<HostCapabilities>): HostCapabilities {
  return { npu: NO, nvidia: NO, apple: NO, vulkan: NO, probedAt: 0, ...over };
}

const LINUX: HostInfo = { platform: 'linux', arch: 'x64', totalMemoryBytes: 64e9 };
const MAC: HostInfo = { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 64e9 };

function rank(
  host: HostInfo,
  capabilities: HostCapabilities | undefined,
  extra: Partial<Parameters<typeof rankEngines>[0]> = {},
): Ranking {
  return rankEngines({
    host,
    capabilities,
    engines: ENGINES,
    installed: new Set(),
    explicit: null,
    ...extra,
  });
}

function ladder(r: Ranking): string[] {
  return r.candidates.filter((c) => c.eligible).map((c) => `${c.engine}:${c.backend}`);
}

describe('engine ranking', () => {
  it('Linux with an NPU: FLM NPU first, CPU last', () => {
    const r = rank(LINUX, caps({ npu: YES() }));
    assert.deepEqual(ladder(r), ['fastflowlm:NPU', 'strands-decider:CPU']);
    assert.equal(r.automatic?.engine, 'fastflowlm');
    assert.equal(r.automatic?.model, 'd3:mini');
  });

  it('Linux with NVIDIA: CUDA then CPU', () => {
    const r = rank(LINUX, caps({ nvidia: YES() }));
    assert.deepEqual(ladder(r), ['strands-decider:CUDA', 'strands-decider:CPU']);
  });

  it('plain Linux, and unknowns, fall to CPU; unknown is not available', () => {
    assert.deepEqual(ladder(rank(LINUX, caps({}))), ['strands-decider:CPU']);
    const unknowns = rank(LINUX, caps({ npu: MAYBE, nvidia: MAYBE, apple: MAYBE }));
    assert.deepEqual(ladder(unknowns), ['strands-decider:CPU']);
    assert.deepEqual(ladder(rank(LINUX, undefined)), ['strands-decider:CPU']);
    const npu = unknowns.candidates.find((c) => c.backend === 'NPU');
    assert.match(npu?.reason ?? '', /not confirmed/);
  });

  it('Apple Silicon with MLX: MLX then CPU (MPS not confirmed)', () => {
    const r = rank(MAC, caps({ apple: YES('mlx') }));
    assert.deepEqual(ladder(r), ['strands-decider:MLX', 'strands-decider:CPU']);
  });

  it('Apple Silicon with MLX and a confirmed MPS: MLX, MPS, CPU', () => {
    const r = rank(MAC, caps({ apple: { ...YES('mlx'), mps: true } }));
    assert.deepEqual(ladder(r), [
      'strands-decider:MLX',
      'strands-decider:MPS',
      'strands-decider:CPU',
    ]);
  });

  it('flags engines that can never run on this host as unsupported', () => {
    const r = rank(MAC, caps({ apple: YES('mlx') }));
    const flm = r.candidates.find((c) => c.engine === 'fastflowlm');
    assert.equal(flm?.supported, false);
    assert.ok(r.candidates.filter((c) => c.engine !== 'fastflowlm').every((c) => c.supported));
  });

  it('Apple Silicon without MLX: MPS then CPU', () => {
    const r = rank(MAC, caps({ apple: YES('mps') }));
    assert.deepEqual(ladder(r), ['strands-decider:MPS', 'strands-decider:CPU']);
  });

  it('never ranks Vulkan, and never recommends uncalibrated engines', () => {
    const r = rank(LINUX, caps({ vulkan: YES() }));
    assert.deepEqual(ladder(r), ['strands-decider:CPU']);
    assert.ok(r.candidates.every((c) => c.engine !== 'vulkan'));
    for (const id of ['lmstudio', 'openai-compatible']) {
      const c = r.candidates.find((x) => x.engine === id);
      assert.equal(c?.eligible, false);
      assert.match(c?.reason ?? '', /uncalibrated/);
    }
  });

  it('explicit selection wins but the list and automatic pick remain', () => {
    const explicit = { engine: 'lmstudio', model: 'qwen', device: null };
    const r = rank(LINUX, caps({ npu: YES() }), { explicit });
    assert.equal(r.recommended?.engine, 'lmstudio');
    assert.equal(r.recommended?.explicit, true);
    assert.equal(r.automatic?.engine, 'fastflowlm');
    assert.ok(r.candidates.length > 2);
  });

  it('rejects a model that does not fit memory instead of substituting', () => {
    const small: HostInfo = { ...LINUX, totalMemoryBytes: 4e9 };
    const r = rank(small, caps({ npu: YES() }));
    assert.deepEqual(ladder(r), []);
    assert.equal(r.automatic, null);
    assert.equal(r.recommended, null);
    const flm = r.candidates.find((c) => c.backend === 'NPU');
    assert.match(flm?.reason ?? '', /does not fit/);
    assert.equal(flm?.model, 'd3:mini');
  });

  it('marks installed engines ready', () => {
    const r = rank(LINUX, caps({}), { installed: new Set(['strands-decider']) });
    assert.equal(r.candidates.find((c) => c.backend === 'CPU')?.ready, true);
  });
});
