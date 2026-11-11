import { totalmem } from 'node:os';

import type { HostInfo } from './descriptor.ts';

export function hostInfo(): HostInfo {
  const { platform, arch } = process;
  return {
    platform,
    arch,
    totalMemoryBytes: totalmem(),
  };
}
