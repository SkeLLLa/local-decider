import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EngineInstallUsageError, formatEngineList, planInstall } from '../src/cli-engine.ts';
import type { HostInfo } from '../src/engines/descriptor.ts';

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
