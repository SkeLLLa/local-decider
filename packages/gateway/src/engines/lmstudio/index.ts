import { defineEngine } from '../descriptor.ts';
import { lmStudioSchema, OpenAICompatibleEngine } from '../openai/index.ts';

/**
 * LM Studio's local server through the OpenAI-compatible adapter. It returns logprobs only from
 * chat completions with a few tokens, so those and `/no_think` are the defaults. Models are
 * loaded and unloaded in LM Studio itself; stopping this engine never unloads one.
 */
export const lmStudioEngine = defineEngine({
  id: 'lmstudio',
  label: 'LM Studio',
  description: "Score decision options from LM Studio's local server logprob distribution",
  configSchema: lmStudioSchema,
  selectable: true,
  supports: (host) =>
    host.platform === 'darwin' || host.platform === 'linux'
      ? { ok: true }
      : { ok: false, reason: 'LM Studio is supported on macOS and Linux' },
  tag: () => 'LM Studio',
  calibrated: false,
  models: [],
  create: (config, ctx) => new OpenAICompatibleEngine(config, ctx.env),
});
