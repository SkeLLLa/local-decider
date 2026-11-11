import { z } from 'zod';

import { DEVICES, defineEngine } from '../descriptor.ts';
import { MODELS } from './models.ts';
import { FastFlowLMEngine } from './server.ts';
import { flmModelsPresent, validateFlm } from './status.ts';

export const DEFAULT_FLM_MODEL = 'd3:nano';
const FLM_PMODES = ['powersaver', 'balanced', 'performance', 'turbo'] as const;

const flmSchema = z.strictObject({
  type: z.literal('fastflowlm'),
  /** A d3 decision-model tag served with `flm serve --decision <model>`. */
  model: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*$/)
    .default(DEFAULT_FLM_MODEL),
  /** The `flm` launcher; default: the managed install (`local-decider engine install --engine fastflowlm`). */
  binary: z.string().min(1).optional(),
  /** Attach to a running `flm serve --decision` instead of spawning one. */
  url: z.url().optional(),
  pmode: z.enum(FLM_PMODES).default('performance'),
  startTimeoutSeconds: z.number().int().min(10).max(3600).default(300),
});

export type FlmEngineConfig = z.infer<typeof flmSchema>;

export const fastflowlmEngine = defineEngine({
  id: 'fastflowlm',
  label: 'FastFlowLM',
  description: 'FastFlowLM decision engine for AMD XDNA NPU systems',
  configSchema: flmSchema,
  selectable: true,
  supports: (host) =>
    host.platform === 'linux'
      ? { ok: true }
      : { ok: false, reason: 'FastFlowLM is supported only on Linux' },
  tag: () => 'NPU',
  devices: () => DEVICES,
  calibrated: true,
  models: MODELS,
  modelsPresent: flmModelsPresent,
  downloadSteps: (model, ctx) => {
    const flm = ctx.tools?.flm;
    if (flm === undefined) {
      throw new Error('FastFlowLM is not installed');
    }
    return [{ command: flm, args: ['pull', model.id] }];
  },
  validation: {
    label: 'flm validate',
    hint: 'Checks the NPU and driver; takes a few seconds.',
    onStart: true,
    run: validateFlm,
  },
  create: (config, ctx) => new FastFlowLMEngine(config, ctx.paths, ctx.tools),
});
