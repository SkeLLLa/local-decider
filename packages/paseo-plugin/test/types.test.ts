import type * as core from '@local-decider/core';
/**
 * The plugin copies the gateway wire types (shared/decision.ts) instead of importing them; this
 * file fails `tsc` when they drift from `@local-decider/core`.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import type * as local from '../shared/decision.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type Checks = [
  Assert<Same<local.DecideResponse, core.DecideResponse>>,
  Assert<Same<local.Answer, core.Answer>>,
  Assert<Same<local.Mode, core.Mode>>,
  Assert<Same<local.GatewayHealth, core.GatewayHealth>>,
  Assert<Same<local.OutcomeSource, core.OutcomeRecord['source']>>,
  // The plugin only ever sends `harness: 'paseo'`, so its request must fit core's.
  Assert<local.DecideRequest extends core.DecideRequest ? true : false>,
  Assert<Same<local.DecisionModels, core.DecisionModels>>,
  Assert<Same<local.UsageReport, Omit<core.UsageRecord, 'kind' | 'ts'>>>,
];

it('shared/decision.ts matches @local-decider/core (checked by tsc)', () => {
  assert.ok(true);
});
