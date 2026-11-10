/** Client → daemon calls. The gateway is reached only from the daemon: it binds loopback there. */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

import { decisionRowSchema } from './row.ts';

export const statusRpc = defineRpc({
  name: 'status',
  input: z.object({}),
  output: z.object({
    up: z.boolean(),
    status: z.enum(['ok', 'degraded', 'down']),
    engine: z.string().nullable(),
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
  output: z.object({ ok: z.boolean(), text: z.string() }),
});

export const gatewayModelsRpc = defineRpc({
  name: 'gateway-models',
  input: z.object({}),
  output: z.object({ models: z.array(z.string()) }),
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
