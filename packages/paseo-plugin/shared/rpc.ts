/** Client → daemon calls. The gateway is reached only from the daemon: it binds loopback there. */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

import { DEVICES } from './constants.ts';
import { decisionRowSchema } from './row.ts';
import { policyStatsSchema } from './stats.ts';

export const statusRpc = defineRpc({
  name: 'status',
  input: z.object({}),
  output: z.object({
    up: z.boolean(),
    status: z.enum(['ok', 'degraded', 'down']),
    engine: z.string().nullable(),
    /** `stopped|starting|ready|failed`, and why when not ready. */
    engineState: z.string().nullable(),
    detail: z.string().nullable(),
    model: z.string().nullable(),
    p50Ms: z.number().nullable(),
    gatewayUrl: z.string(),
    /** Consecutive failed checks, for client-side backoff. */
    downStreak: z.number().int(),
    checkedAt: z.string(),
  }),
});

export const statsRpc = defineRpc({
  name: 'stats',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), text: z.string(), policies: z.array(policyStatsSchema) }),
});

export const gatewayModelsRpc = defineRpc({
  name: 'gateway-models',
  input: z.object({}),
  output: z.object({
    reachable: z.boolean(),
    active: z.string().nullable(),
    device: z.string().nullable(),
    switchable: z.boolean(),
    models: z.array(z.object({ id: z.string(), memoryGb: z.number().nullable() })),
  }),
});

/** Ask the gateway to serve another model now (`POST /v1/engine`). */
export const selectModelRpc = defineRpc({
  name: 'select-model',
  input: z.object({ model: z.string().min(1).max(300), device: z.enum(DEVICES) }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

/** Report the right answer for a decision row and mark the row. */
export const feedbackRpc = defineRpc({
  name: 'feedback',
  input: z.object({
    agentId: z.string().min(1).max(200),
    row: decisionRowSchema,
    outcome: z.string().min(1).max(100),
  }),
  output: decisionRowSchema,
});

export const decideRpc = defineRpc({
  name: 'decide',
  input: z.object({
    policy: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    text: z.string().max(20_000),
    agentId: z.string().nullable(),
  }),
  output: decisionRowSchema,
});
