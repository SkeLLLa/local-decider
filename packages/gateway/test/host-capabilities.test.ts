import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  invalidateHostCapabilities,
  probeHostCapabilities,
  type CapabilityFs,
  type ProbeDeps,
  type ProbeOptions,
} from '../src/engines/host-capabilities.ts';

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeFs(files: Record<string, string>, denied: string[] = []): CapabilityFs {
  return {
    list: (dir) => {
      const prefix = `${dir}/`;
      const names = Object.keys(files)
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => p.slice(prefix.length));
      if (
        dir !== '/dev' &&
        names.length === 0 &&
        !Object.keys(files).some((p) => p.startsWith(prefix))
      ) {
        throw errno('ENOENT');
      }
      return names;
    },
    read: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw errno('ENOENT');
      }
      return text;
    },
    access: (path) => {
      if (denied.includes(path)) {
        throw errno('EACCES');
      }
    },
  };
}

type Runs = Record<string, string | Error>;

function deps(over: Partial<ProbeDeps> & { tools?: string[]; runs?: Runs } = {}): ProbeOptions {
  const { tools = [], runs = {}, ...rest } = over;
  const calls: string[] = [];
  const d: Partial<ProbeDeps> = {
    platform: 'linux',
    arch: 'x64',
    fs: fakeFs({}),
    which: (name) => (tools.includes(name) ? `/usr/bin/${name}` : undefined),
    run: async (file) => {
      calls.push(file);
      const out = runs[file];
      if (out === undefined || out instanceof Error) {
        throw out ?? errno('ENOENT');
      }
      return out;
    },
    now: () => 0,
    ...rest,
  };
  return { deps: d };
}

const NPU_FILES = {
  '/dev/accel/accel0': '',
  '/sys/class/accel/accel0/device/uevent': 'DRIVER=amdxdna\nPCI_ID=1022:17F0\n',
};

const vulkanSummary = (name: string): string => `Devices:\n GPU0:\n  deviceName = ${name}\n`;

describe('host capability probes', () => {
  beforeEach(() => invalidateHostCapabilities());

  it('reports absent tools and devices as unavailable or unknown', async () => {
    const caps = await probeHostCapabilities(deps());
    assert.equal(caps.npu.status, 'unavailable');
    assert.equal(caps.nvidia.status, 'unavailable');
    assert.equal(caps.apple.status, 'unavailable');
    assert.equal(caps.vulkan.status, 'unknown');
  });

  it('finds an AMD NPU only with accel device, amdxdna driver and access', async () => {
    const ok = await probeHostCapabilities(deps({ fs: fakeFs(NPU_FILES) }));
    assert.equal(ok.npu.status, 'available');
  });

  it('is unknown for an inaccessible accel device (EACCES)', async () => {
    const caps = await probeHostCapabilities(
      deps({ fs: fakeFs(NPU_FILES, ['/dev/accel/accel0']) }),
    );
    assert.equal(caps.npu.status, 'unknown');
  });

  it('does not count amdxdna without an accel device', async () => {
    const caps = await probeHostCapabilities(
      deps({ fs: fakeFs({ '/sys/module/amdxdna/version': '1' }) }),
    );
    assert.equal(caps.npu.status, 'unavailable');
  });

  it('rejects an accel device bound to another driver', async () => {
    const caps = await probeHostCapabilities(
      deps({
        fs: fakeFs({
          '/dev/accel/accel0': '',
          '/sys/class/accel/accel0/device/uevent': 'DRIVER=habanalabs\n',
        }),
      }),
    );
    assert.equal(caps.npu.status, 'unavailable');
  });

  it('detects NVIDIA via device nodes and nvidia-smi', async () => {
    const caps = await probeHostCapabilities(
      deps({
        fs: fakeFs({ '/dev/nvidia0': '', '/dev/nvidiactl': '' }),
        tools: ['nvidia-smi'],
        runs: { '/usr/bin/nvidia-smi': 'NVIDIA RTX 4090, 24564\n' },
      }),
    );
    assert.equal(caps.nvidia.status, 'available');
    assert.equal(caps.nvidia.evidence, 'NVIDIA RTX 4090, 24564 MiB');
  });

  it('is unknown when nvidia nodes exist but nvidia-smi is missing or fails', async () => {
    const fs = fakeFs({ '/dev/nvidia0': '' });
    assert.equal((await probeHostCapabilities(deps({ fs }))).nvidia.status, 'unknown');
    invalidateHostCapabilities();
    const failing = deps({
      fs,
      tools: ['nvidia-smi'],
      runs: { '/usr/bin/nvidia-smi': errno('EPERM') },
    });
    assert.equal((await probeHostCapabilities(failing)).nvidia.status, 'unknown');
  });

  it('excludes software Vulkan devices', async () => {
    const software = await probeHostCapabilities(
      deps({
        tools: ['vulkaninfo'],
        runs: { '/usr/bin/vulkaninfo': vulkanSummary('llvmpipe (LLVM 17)') },
      }),
    );
    assert.equal(software.vulkan.status, 'unavailable');
    invalidateHostCapabilities();
    const hardware = await probeHostCapabilities(
      deps({ tools: ['vulkaninfo'], runs: { '/usr/bin/vulkaninfo': vulkanSummary('AMD Radeon') } }),
    );
    assert.equal(hardware.vulkan.status, 'available');
  });

  it('turns timeouts and an exhausted shared deadline into unknown', async () => {
    const timeout = await probeHostCapabilities(
      deps({ tools: ['vulkaninfo'], runs: { '/usr/bin/vulkaninfo': errno('ETIMEDOUT') } }),
    );
    assert.equal(timeout.vulkan.status, 'unknown');
    invalidateHostCapabilities();
    let ran = false;
    const late = await probeHostCapabilities({
      ...deps({
        tools: ['vulkaninfo'],
        run: async () => {
          ran = true;
          return '';
        },
      }),
      budgetMs: 0,
    });
    assert.equal(late.vulkan.status, 'unknown');
    assert.equal(ran, false);
  });

  it('probes the Python of a custom Strands environment on Apple Silicon', async () => {
    const options = {
      ...deps({
        platform: 'darwin',
        arch: 'arm64',
        runs: {
          '/opt/custom/env/bin/python': '{"mlx": true, "metal": true, "mps": true}\n',
        },
      }),
      strandsDecider: '/opt/custom/env/bin/strands-decider',
    };
    const caps = await probeHostCapabilities(options);
    assert.equal(caps.apple.status, 'available');
    assert.equal(caps.apple.evidence, 'MLX with Metal');
    assert.equal(caps.apple.mps, true);
  });

  it('falls back to MPS, then reports unknown without an environment', async () => {
    const runs = { '/env/bin/python': '{"mlx": false, "metal": false, "mps": true}' };
    const base = deps({ platform: 'darwin', arch: 'arm64', runs });
    const mps = await probeHostCapabilities({
      ...base,
      strandsDecider: '/env/bin/strands-decider',
    });
    assert.equal(mps.apple.evidence, 'PyTorch MPS');
    invalidateHostCapabilities();
    assert.equal((await probeHostCapabilities(base)).apple.status, 'unknown');
  });

  it('caches until invalidated', async () => {
    let calls = 0;
    const options = deps({ tools: ['vulkaninfo'], run: async () => (calls++, 'deviceName = X') });
    await probeHostCapabilities(options);
    await probeHostCapabilities(options);
    assert.equal(calls, 1);
    invalidateHostCapabilities();
    await probeHostCapabilities(options);
    assert.equal(calls, 2);
  });
});
