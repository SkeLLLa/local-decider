import { createHash } from 'node:crypto';
import { cpus } from 'node:os';

import type { HostInfo } from './descriptor.ts';
import type { HostCapabilities } from './host-capabilities.ts';

function evidence(capability: HostCapabilities['npu']): string | null {
  return capability.status === 'available' ? capability.evidence : null;
}

export function hardwareFingerprint(
  host: HostInfo,
  capabilities: HostCapabilities | undefined,
): string | undefined {
  if (capabilities === undefined) return undefined;
  const canonical = JSON.stringify({
    platform: host.platform,
    arch: host.arch,
    cpu: cpus()[0]?.model ?? '',
    memoryGb: Math.round(host.totalMemoryBytes / 2 ** 30),
    npu: evidence(capabilities.npu),
    nvidia: evidence(capabilities.nvidia),
    vulkan: evidence(capabilities.vulkan),
    apple: evidence(capabilities.apple),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
