import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  configIsExplicit,
  EngineInstallUsageError,
  formatEngineList,
  planInstall,
  type InstallPlan,
} from '../src/cli-engine.ts';
import { parseConfig } from '../src/config.ts';
import type { AutoInstall } from '../src/engine-install-auto.ts';
import type { HostInfo } from '../src/engines/descriptor.ts';
import type { HostCapabilities } from '../src/engines/host-capabilities.ts';
import { ENGINES } from '../src/engines/registry.ts';
import { rankEngines } from '../src/engines/selector.ts';

function planAuto(argv: string[], host: HostInfo, auto: AutoInstall): InstallPlan {
  return planInstall(argv, host, 'strands-decider', undefined, auto);
}

const linux: HostInfo = {
  platform: 'linux',
  arch: 'x64',
  totalMemoryBytes: 32 * 1024 ** 3,
};
const darwin: HostInfo = {
  platform: 'darwin',
  arch: 'arm64',
  totalMemoryBytes: 32 * 1024 ** 3,
};

describe('engine install planning', () => {
  it('defaults to strands-decider and selects the host flavor', () => {
    assert.deepEqual(planInstall([], linux, 'strands-decider', 'adapter/model'), {
      engine: 'strands-decider',
      flavor: 'cpu',
      model: 'adapter/model',
    });
    assert.deepEqual(planInstall([], darwin, 'strands-decider', 'adapter/model'), {
      engine: 'strands-decider',
      flavor: 'mlx',
      model: 'adapter/model',
    });
  });

  it('accepts each strands flavor and an explicit model', () => {
    for (const flavor of ['cpu', 'mlx', 'cuda']) {
      assert.deepEqual(
        planInstall(['--flavor', flavor, '--model', 'custom/model'], linux, 'strands-decider'),
        { engine: 'strands-decider', flavor, model: 'custom/model' },
      );
    }
    assert.deepEqual(planInstall(['--no-download'], linux, 'strands-decider', 'default'), {
      engine: 'strands-decider',
      flavor: 'cpu',
    });
  });

  it('plans FastFlowLM on Linux x64 and rejects its flavor option', () => {
    assert.deepEqual(
      planInstall(['--engine', 'fastflowlm'], linux, 'strands-decider', 'strands/model'),
      {
        engine: 'fastflowlm',
        noDownload: false,
      },
    );
    assert.deepEqual(planInstall([], linux, 'fastflowlm', 'd3:nano'), {
      engine: 'fastflowlm',
      model: 'd3:nano',
      noDownload: false,
    });
    assert.deepEqual(planInstall(['--no-download'], linux, 'fastflowlm', 'd3:nano'), {
      engine: 'fastflowlm',
      model: 'd3:nano',
      noDownload: true,
    });
    assert.throws(
      () => planInstall(['--engine', 'fastflowlm', '--flavor', 'cpu'], linux, 'strands-decider'),
      (error: unknown) =>
        error instanceof EngineInstallUsageError &&
        error.exitCode === 2 &&
        /--flavor is only valid/.test(error.message),
    );
  });

  it('plans a llama Vulkan model download on Linux and rejects its flavor', () => {
    assert.deepEqual(planInstall(['--engine', 'llama-vulkan'], linux, 'strands-decider'), {
      engine: 'llama-vulkan',
      noDownload: false,
    });
    assert.deepEqual(
      planInstall(
        ['--engine', 'llama-vulkan', '--model', 'd3-nano-q8_0'],
        linux,
        'strands-decider',
      ),
      {
        engine: 'llama-vulkan',
        model: 'd3-nano-q8_0',
        noDownload: false,
      },
    );
    assert.deepEqual(
      planInstall(['--engine', 'llama-vulkan', '--no-download'], linux, 'strands-decider'),
      {
        engine: 'llama-vulkan',
        noDownload: true,
      },
    );
    assert.throws(
      () => planInstall(['--engine', 'llama-vulkan', '--flavor', 'cpu'], linux, 'strands-decider'),
      /--flavor is only valid/,
    );
    assert.throws(
      () => planInstall(['--engine', 'llama-vulkan'], darwin, 'strands-decider'),
      /llama-vulkan runs on Linux x86_64/,
    );
  });

  it('refuses FastFlowLM on Darwin and non-x64 Linux', () => {
    for (const host of [darwin, { ...linux, arch: 'arm64' as const }]) {
      assert.throws(
        () => planInstall(['--engine', 'fastflowlm'], host, 'strands-decider'),
        (error: unknown) =>
          error instanceof EngineInstallUsageError &&
          error.exitCode === 2 &&
          error.message ===
            'fastflowlm runs on Linux x86_64 with an AMD XDNA2 NPU; on macOS use strands-decider (MLX) or openai-compatible',
      );
    }
  });

  it('refuses engines with no installer and rejects invalid flavors', () => {
    assert.throws(
      () => planInstall([], linux, 'openai-compatible'),
      /nothing to install for openai-compatible: start your server and set engines.openai-compatible.url/,
    );
    assert.throws(
      () => planInstall([], linux, 'lmstudio'),
      /nothing to install for lmstudio: get LM Studio from https:\/\/lmstudio\.ai\/download.*lms server start/,
    );
    assert.throws(
      () => planInstall(['--flavor', 'metal'], linux, 'strands-decider'),
      /invalid strands-decider flavor/,
    );
  });

  it('uses the configured model only when the install target matches', () => {
    assert.equal(
      planInstall(['--engine', 'fastflowlm'], linux, 'strands-decider', 'strands/model').model,
      undefined,
    );
    assert.equal(
      planInstall(['--engine', 'strands-decider'], linux, 'fastflowlm', 'd3:nano').model,
      undefined,
    );
  });
});

describe('engine list formatting', () => {
  it('formats engine support, active state, descriptions and models', () => {
    const formatted = formatEngineList({
      active: { engine: 'openai-compatible', model: 'local-qwen' },
      engines: [
        {
          id: 'fastflowlm',
          label: 'FastFlowLM (AMD NPU)',
          supported: false,
          unsupportedReason: 'FastFlowLM is supported only on Linux',
          detail: 'not installed',
        },
        {
          id: 'openai-compatible',
          label: 'OpenAI-compatible',
          supported: true,
          detail: 'http://127.0.0.1:1234/v1',
        },
      ],
      models: [
        { id: 'd3:nano', engine: 'fastflowlm', installed: false },
        { id: 'local-qwen', engine: 'openai-compatible', installed: true },
      ],
    });
    assert.match(formatted, /fastflowlm \| supported: no \| FastFlowLM is supported only on Linux/);
    assert.match(formatted, /  d3:nano \(not installed\)/);
    assert.match(formatted, /openai-compatible \| supported: yes \| active \| OpenAI-compatible/);
    assert.match(formatted, /  local-qwen \(installed\)/);
  });

  it('returns one line for an unparseable payload', () => {
    assert.equal(
      formatEngineList('not an engine catalog'),
      'gateway returned an invalid engine list',
    );
  });
});

describe('automatic install planning', () => {
  const NO = { status: 'unavailable', evidence: 'x' } as const;
  const YES = { status: 'available', evidence: 'ok' } as const;
  const base: HostCapabilities = { npu: NO, nvidia: NO, apple: NO, vulkan: NO, probedAt: 0 };

  function auto(
    host: HostInfo,
    caps: Partial<HostCapabilities> = {},
    installed: ReadonlySet<string> = new Set(),
  ): AutoInstall {
    return {
      ranking: rankEngines({
        host,
        capabilities: { ...base, ...caps },
        engines: ENGINES,
        installed,
        explicit: null,
      }),
    };
  }

  it('plans FLM d3:mini on a supported NPU', () => {
    const p = planAuto([], linux, auto(linux, { npu: YES }));
    assert.equal(p.engine, 'fastflowlm');
    assert.equal(p.model, 'd3:mini');
    assert.match(p.reason ?? '', /fastflowlm \(NPU\)/);
  });

  it('plans the mlx flavor on a fresh Mac and on Mac with MLX', () => {
    for (const apple of [base.apple, { ...YES, variant: 'mlx' as const }]) {
      const p = planAuto([], darwin, auto(darwin, { apple }));
      assert.equal(p.engine, 'strands-decider');
      assert.equal(p.engine === 'strands-decider' && p.flavor, 'mlx');
      assert.ok(p.model?.includes('strands-decider-2B'));
    }
  });

  it('plans torch (MPS) on a Mac with MPS only', () => {
    const p = planAuto([], darwin, auto(darwin, { apple: { ...YES, variant: 'mps' } }));
    assert.equal(p.engine === 'strands-decider' && p.flavor, 'cpu');
    assert.match(p.reason ?? '', /MPS/);
  });

  it('plans cuda on NVIDIA and cpu otherwise', () => {
    const cuda = planAuto([], linux, auto(linux, { nvidia: YES }));
    assert.equal(cuda.engine === 'strands-decider' && cuda.flavor, 'cuda');
    const cpu = planAuto([], linux, auto(linux));
    assert.equal(cpu.engine === 'strands-decider' && cpu.flavor, 'cpu');
  });

  it('keeps generic install on CPU without llama-server but honors an explicit llama request', () => {
    const vulkan = auto(linux, { vulkan: YES });
    assert.equal(planAuto([], linux, vulkan).engine, 'strands-decider');
    const explicit = planAuto(['--engine', 'llama-vulkan'], linux, vulkan);
    assert.equal(explicit.engine, 'llama-vulkan');
    assert.equal(explicit.model, 'd3-mini-q4_k_m');
    assert.equal(explicit.engine === 'llama-vulkan' && explicit.noDownload, false);
    assert.equal(
      planAuto([], linux, auto(linux, { vulkan: YES }, new Set(['llama-vulkan']))).engine,
      'llama-vulkan',
    );
  });

  it('lets CLI flags beat the ranking', () => {
    const a = auto(linux, { npu: YES });
    const p = planAuto(
      ['--engine', 'strands-decider', '--flavor', 'cuda', '--model', 'my/model'],
      linux,
      a,
    );
    assert.deepEqual(
      [p.engine, p.engine === 'strands-decider' && p.flavor, p.model],
      ['strands-decider', 'cuda', 'my/model'],
    );
  });

  it('lets explicit config beat the ranking (no auto input)', () => {
    const p = planInstall([], linux, 'strands-decider', 'cfg/model');
    assert.deepEqual(p, { engine: 'strands-decider', flavor: 'cpu', model: 'cfg/model' });
    assert.equal(configIsExplicit(parseConfig({})), false);
    assert.equal(configIsExplicit(parseConfig({ engine: { type: 'fastflowlm' } })), true);
    const selection = { engine: 'fastflowlm', model: 'd3:nano' };
    assert.equal(configIsExplicit(parseConfig({ selection })), true);
  });

  it('keeps --no-download and prepares without selecting anything', () => {
    const strands = planAuto(['--no-download'], linux, auto(linux));
    assert.equal(strands.model, undefined);
    const flm = planAuto(['--no-download'], linux, auto(linux, { npu: YES }));
    assert.deepEqual(
      [flm.engine, flm.engine === 'fastflowlm' && flm.noDownload],
      ['fastflowlm', true],
    );
    assert.ok(!('device' in flm) && !('selection' in flm));
  });

  it('rejects instead of substituting when the model does not fit', () => {
    const tiny: HostInfo = { ...linux, totalMemoryBytes: 2e9 };
    assert.throws(() => planAuto([], tiny, auto(tiny, { npu: YES })), EngineInstallUsageError);
  });
});
