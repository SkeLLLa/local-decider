/** Client → daemon calls. The gateway is reached only from the daemon: it binds loopback there. */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

import { CONNECTABLE_ENGINES, connectionSchema, discoverySchema } from './connection.ts';
import { HOOK_POLICIES, SERVICE_ACTIONS } from './constants.ts';
import { downloadSchema, engineCatalogSchema, validationSchema } from './engines.ts';
import { IDLE_MINUTES } from './lifecycle.ts';
import { PATH_KEY, pathEntrySchema } from './paths.ts';
import {
  policyPromptSchema,
  policyThresholdsSchema,
  policyVariantsSchema,
  routingSettingsSchema,
} from './policies.ts';
import { decisionRowSchema } from './row.ts';
import { policyStatsSchema } from './stats.ts';

export const statusRpc = defineRpc({
  name: 'status',
  input: z.object({}),
  output: z.object({
    up: z.boolean(),
    status: z.enum(['ok', 'degraded', 'down']),
    engine: z.string().nullable(),
    engineTag: z.string().nullable(),
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

/** Automatic selection on, or off keeping the running engine (`POST /v1/engine/mode`). */
export const selectionModeRpc = defineRpc({
  name: 'selection-mode',
  input: z.object({ mode: z.enum(['auto', 'manual']) }),
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

/** Save an OpenAI-like engine's connection (`POST /v1/config/engine`); does not select it. */
export const saveConnectionRpc = defineRpc({
  name: 'save-connection',
  input: z.object({
    engine: z.enum(CONNECTABLE_ENGINES),
    url: z.string().min(1).max(2048),
    model: id,
    tokenEnv: z.string().max(128).nullable(),
  }),
  output: z.object({ ok: z.boolean(), error: failure, connection: connectionSchema.nullable() }),
});

/** `POST /v1/engines/discover`: no input lists local suggestions, `{engine, url}` probes a URL. */
export const discoverServersRpc = defineRpc({
  name: 'discover-servers',
  input: z.object({
    engine: z.enum(CONNECTABLE_ENGINES).optional(),
    url: z.string().max(2048).optional(),
  }),
  output: discoverySchema,
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

/** A hook policy and the variants that can answer for it (`GET /v1/policies`). */
export const policyVariantsRpc = defineRpc({
  name: 'policy-variants',
  input: z.object({ policy: z.enum(HOOK_POLICIES) }),
  output: policyVariantsSchema,
});

/** Which variant answers for a hook policy (`POST /v1/policies/:id/variant`); persisted. */
export const policyVariantRpc = defineRpc({
  name: 'policy-variant',
  input: z.object({
    policy: z.enum(HOOK_POLICIES),
    variant: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  }),
  output: z.object({ ok: z.boolean(), error: failure }),
});

/** The rule thresholds in effect for a hook policy, with their defaults (`GET /v1/policies`). */
export const policyThresholdsRpc = defineRpc({
  name: 'policy-thresholds',
  input: z.object({ policy: z.enum(HOOK_POLICIES) }),
  output: policyThresholdsSchema,
});

/**
 * Override rule thresholds of a policy (or a variant) by `<question>.<answer>`; null restores the
 * file's value (`POST /v1/policies/:id/thresholds`); persisted in config.yaml.
 */
export const setPolicyThresholdsRpc = defineRpc({
  name: 'set-policy-thresholds',
  input: z.object({
    policy: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    thresholds: z
      .record(z.string().min(3).max(200), z.number().min(0).max(1).nullable())
      .refine((t) => Object.keys(t).length >= 1 && Object.keys(t).length <= 64, {
        message: '1..64 thresholds',
      }),
  }),
  output: z.object({ ok: z.boolean(), error: failure }),
});

/** Re-read the gateway's policy files (`POST /v1/policies/reload`). */
export const reloadPoliciesRpc = defineRpc({
  name: 'reload-policies',
  input: z.object({}),
  output: z.object({ ok: z.boolean(), error: failure, count: z.number().int() }),
});

/** Paseo's routing presets from the gateway's config.yaml, and where that file is. */
export const routingSettingsRpc = defineRpc({
  name: 'routing-settings',
  input: z.object({}),
  output: routingSettingsSchema,
});

const presetName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);

/** Map (or with a null model, remove) one Paseo preset in config.yaml. */
export const routingPresetRpc = defineRpc({
  name: 'routing-preset',
  input: z.object({
    preset: presetName,
    /** `provider/model`; with neither a model nor a profile the mapping is removed. */
    model: z.string().max(300).optional(),
    /** A Paseo agent profile id. */
    profile: z.string().max(200).optional(),
    mode: z.string().max(200).optional(),
    thinking: z.string().max(100).optional(),
  }),
  output: z.object({ ok: z.boolean(), error: failure }),
});

/** The prompt that has an agent write a variant of a hook policy, and where it should run. */
export const policyPromptRpc = defineRpc({
  name: 'policy-prompt',
  input: z.object({ policy: z.enum(HOOK_POLICIES) }),
  output: policyPromptSchema,
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
