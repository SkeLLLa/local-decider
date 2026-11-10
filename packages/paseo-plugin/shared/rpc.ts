/** Client → daemon calls. The gateway is reached only from the daemon: it binds loopback there. */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

import { HOOK_POLICIES, SERVICE_ACTIONS } from './constants.ts';
import { downloadSchema, engineCatalogSchema, validationSchema } from './engines.ts';
import { IDLE_MINUTES } from './lifecycle.ts';
import { PATH_KEY, pathEntrySchema } from './paths.ts';
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

/** `GET /v1/engines` through the daemon: engines, models, downloads and the active choice. */
export const enginesRpc = defineRpc({
  name: 'engines',
  input: z.object({}),
  output: engineCatalogSchema,
});

const id = z.string().min(1).max(300);
const failure = z.string().nullable();

/** Switch the gateway's engine and model now (`POST /v1/engine`); the gateway persists it. */
export const selectEngineRpc = defineRpc({
  name: 'select-engine',
  input: z.object({
    engine: id,
    model: id,
    /** `auto` keeps the gateway's device. */
    device: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  }),
  output: z.object({ ok: z.boolean(), error: failure }),
});

/** Start a model download (`POST /v1/models/download`). */
export const downloadModelRpc = defineRpc({
  name: 'download-model',
  input: z.object({ engine: id, model: id }),
  output: z.object({ ok: z.boolean(), error: failure, download: downloadSchema.nullable() }),
});

/** Re-run an engine's self check (`POST /v1/engines/validate`), e.g. FastFlowLM's `flm validate`. */
export const validateEngineRpc = defineRpc({
  name: 'validate-engine',
  input: z.object({ engine: id }),
  output: z.object({ ok: z.boolean(), error: failure, validation: validationSchema.nullable() }),
});

/** Set a tool path or directory (`POST /v1/paths`); null goes back to automatic discovery. */
export const setPathRpc = defineRpc({
  name: 'set-path',
  input: z.object({
    key: z.string().max(100).regex(PATH_KEY),
    value: z.string().min(1).max(1000).nullable(),
  }),
  output: z.object({ ok: z.boolean(), error: failure, entry: pathEntrySchema.nullable() }),
});

/** Load the model now or free it (`POST /v1/engine/load|unload`). */
export const engineLoadRpc = defineRpc({
  name: 'engine-load',
  input: z.object({ action: z.enum(['load', 'unload']) }),
  output: z.object({ ok: z.boolean(), error: failure }),
});

/** Lazy (load on demand, unload when idle) or eager (`POST /v1/engine/lifecycle`). */
export const policyModeRpc = defineRpc({
  name: 'policy-mode',
  input: z.object({ policy: z.enum(HOOK_POLICIES), mode: z.enum(['off', 'shadow', 'act']) }),
  output: z.object({ ok: z.boolean(), error: failure }),
});

export const lifecycleRpc = defineRpc({
  name: 'engine-lifecycle',
  input: z.object({
    lifecycle: z.enum(['lazy', 'eager']),
    idleUnloadMinutes: z.number().int().min(IDLE_MINUTES.min).max(IDLE_MINUTES.max).optional(),
  }),
  output: z.object({ ok: z.boolean(), error: failure }),
});

/** Which user service manager runs the gateway, and the exact command behind each button. */
export const serviceInfoRpc = defineRpc({
  name: 'service-info',
  input: z.object({}),
  output: z.object({
    manager: z.enum(['systemd', 'launchd']).nullable(),
    commands: z.record(z.enum(SERVICE_ACTIONS), z.string()).nullable(),
  }),
});

/** Start, stop or restart the gateway's user service with a fixed argv. */
export const serviceRpc = defineRpc({
  name: 'service',
  input: z.object({ action: z.enum(SERVICE_ACTIONS) }),
  output: z.object({
    ok: z.boolean(),
    command: z.string().nullable(),
    output: z.string(),
    error: failure,
  }),
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
