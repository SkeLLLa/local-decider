import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HostInfo } from '../src/engines/descriptor.ts';
import { hardwareFingerprint } from '../src/engines/fingerprint.ts';
import type { CapabilityResult, HostCapabilities } from '../src/engines/host-capabilities.ts';

const host: HostInfo = { platform: 'linux', arch: 'x64', totalMemoryBytes: 16 * 2 ** 30 };

function capability(status: CapabilityResult['status'], evidence: string): CapabilityResult {
  return { status, evidence };
}

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    npu: capability('unavailable', 'no npu'),
    nvidia: capability('unavailable', 'no nvidia'),
    vulkan: capability('unavailable', 'no vulkan'),
    apple: capability('unavailable', 'no apple'),
    probedAt: 1,
    ...overrides,
  };
}

describe('hardware fingerprint', () => {
  it('is stable and unavailable until capabilities are probed', () => {
    const caps = capabilities({ vulkan: capability('available', 'Radeon Vulkan') });
    assert.equal(hardwareFingerprint(host, caps), hardwareFingerprint(host, caps));
    assert.equal(hardwareFingerprint(host, undefined), undefined);
  });

  it('separates hosts by available NPU and Vulkan evidence', () => {
    const base = capabilities();
    const npu = capabilities({ npu: capability('available', 'AMD XDNA') });
    const vulkan = capabilities({ vulkan: capability('available', 'Radeon 880M') });
    assert.notEqual(hardwareFingerprint(host, base), hardwareFingerprint(host, npu));
    assert.notEqual(hardwareFingerprint(host, base), hardwareFingerprint(host, vulkan));
  });
});
