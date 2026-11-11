import type { ShadowRecord } from '@local-decider/core';

export function makeShadowRecord(
  decisionId: string,
  overrides: Partial<ShadowRecord> = {},
): ShadowRecord {
  return {
    kind: 'decision',
    ts: '2026-11-10T00:00:00.000Z',
    decisionId,
    harness: 'cli',
    policy: 'permission',
    mode: 'shadow',
    inputHash: 'input-hash',
    answers: {},
    action: 'ask',
    enforced: false,
    engine: 'fake',
    model: 'fake',
    latencyMs: 1,
    ...overrides,
  };
}
