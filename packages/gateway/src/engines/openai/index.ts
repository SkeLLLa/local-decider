import {
  canonicalJson,
  cutText,
  tokenAllowed,
  type Question,
  type SystemOneRequest,
  type SystemOneResponse,
  type WireAnswer,
} from '@local-decider/core';
import { z } from 'zod';

import { defineEngine } from '../descriptor.ts';
import { postJson, type JsonRequestOptions } from '../http.ts';
import { EngineError, type Engine, type EngineHealth, type EngineState } from '../types.ts';
import {
  optionMasses,
  parseTopLogprobs,
  renderPrompt,
  toWireAnswer,
  type RenderedPrompt,
  type TopLogprob,
} from './logprob.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const NO_LOGPROBS =
  'server returned no logprobs; LM Studio: try api: completions, or use llama-server/Ollama/mlx_lm.server';
const START_HINT =
  'start LM Studio (lms server start), ollama serve, llama-server or mlx_lm.server';
const PROBE_QUESTION: Question = { type: 'noul', instructions: 'Say yes to confirm logprobs.' };

const openaiCompatibleSchema = z.strictObject({
  type: z.literal('openai-compatible'),
  url: z.url().default('http://127.0.0.1:1234/v1'),
  model: z
    .string()
    .min(1)
    .max(300)
    .regex(/^[^-\s][^\s]*$/),
  api: z.enum(['chat', 'completions']).default('chat'),
  maxTokens: z.number().int().min(1).max(32).default(1),
  promptSuffix: z.string().max(64).optional(),
  tokenEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
  topLogprobs: z.number().int().min(2).max(20).default(20),
  maxOptions: z.number().int().min(2).max(20).default(10),
  minCoverage: z.number().min(0).max(1).default(0.5),
  temperature: z.number().min(0.1).max(10).default(1),
  maxStateChars: z.number().int().min(1000).max(400_000).default(24_000),
  extraBody: z.record(z.string(), z.json()).default({}),
  requestTimeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
});

export type OpenAICompatibleEngineConfig = z.infer<typeof openaiCompatibleSchema>;

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function withSuffix(text: string, suffix: string | undefined): string {
  return suffix === undefined || suffix === '' ? text : `${text}\n${suffix}`;
}

function requestBody(config: OpenAICompatibleEngineConfig, prompt: RenderedPrompt): unknown {
  const common = {
    ...config.extraBody,
    model: config.model,
    max_tokens: config.maxTokens,
    temperature: 1,
    top_p: 1,
    stream: false,
  };
  return config.api === 'chat'
    ? {
        ...common,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: withSuffix(prompt.user, config.promptSuffix) },
        ],
        logprobs: true,
        top_logprobs: config.topLogprobs,
      }
    : {
        ...common,
        prompt: withSuffix(prompt.prompt, config.promptSuffix),
        logprobs: config.topLogprobs,
      };
}

function stateText(state: SystemOneRequest['state'], maxChars: number): string {
  return cutText(typeof state === 'string' ? state : canonicalJson(state), maxChars);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function responseUsage(
  response: unknown,
): { readonly input?: number; readonly output?: number } | undefined {
  const usage = record(record(response)?.['usage']);
  if (usage === undefined) {
    return undefined;
  }
  const input = tokenCount(usage['prompt_tokens']) ?? tokenCount(usage['input_tokens']);
  const output = tokenCount(usage['completion_tokens']) ?? tokenCount(usage['output_tokens']);
  return input === undefined && output === undefined
    ? undefined
    : { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }) };
}

interface UsageTotals {
  input?: number;
  output?: number;
}

function addUsage(
  totals: UsageTotals,
  usage: { readonly input?: number; readonly output?: number } | undefined,
): void {
  if (usage?.input !== undefined) {
    totals.input = (totals.input ?? 0) + usage.input;
  }
  if (usage?.output !== undefined) {
    totals.output = (totals.output ?? 0) + usage.output;
  }
}

function systemOneResponse(
  model: string,
  answers: Record<string, WireAnswer>,
  totals: UsageTotals,
): SystemOneResponse {
  const usage = {
    ...(totals.input === undefined ? {} : { input_tokens: totals.input }),
    ...(totals.output === undefined ? {} : { output_tokens: totals.output }),
  };
  return {
    model,
    answers,
    ...(Object.keys(usage).length === 0 ? {} : { usage }),
  };
}

function lowCoverageDetail(coverage: number): string {
  return `low option coverage ${coverage.toFixed(2)} (thinking model? set extraBody)`;
}

export const openaiCompatibleEngine = defineEngine({
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  description: 'Score decision options from an OpenAI-compatible server logprob distribution',
  configSchema: openaiCompatibleSchema,
  selectable: false,
  supports: () => ({ ok: true }),
  tag: () => 'LLM',
  calibrated: false,
  models: [],
  create: (config, ctx) => new OpenAICompatibleEngine(config, ctx.env),
});

/** A chat-completions or completions endpoint scored by the probability of one option token. */
export class OpenAICompatibleEngine implements Engine {
  readonly id = 'openai-compatible';
  readonly model: string;
  readonly #config: OpenAICompatibleEngineConfig;
  readonly #url: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  #state: EngineState = 'stopped';
  #detail: string | undefined;

  constructor(
    config: OpenAICompatibleEngineConfig,
    env: NodeJS.ProcessEnv = process.env,
    doFetch: typeof fetch = globalThis.fetch,
  ) {
    this.#config = config;
    this.#url = config.url;
    this.model = config.model;
    this.#fetch = doFetch;
    this.#token =
      config.tokenEnv === undefined || !tokenAllowed(config.url) ? undefined : env[config.tokenEnv];
  }

  async start(): Promise<void> {
    this.#state = 'starting';
    try {
      const response = await this.#complete(renderPrompt(PROBE_QUESTION, 'probe'));
      if (parseTopLogprobs(response).length === 0) {
        throw new EngineError(NO_LOGPROBS);
      }
      this.#state = 'ready';
      this.#detail = undefined;
    } catch (error) {
      const message = this.#errorMessage(error);
      this.#state = 'failed';
      this.#detail = message.startsWith('engine unreachable:')
        ? `no server at ${this.#url}; ${START_HINT}`
        : message;
    }
  }

  health(): EngineHealth {
    return {
      state: this.#state,
      model: this.model,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    };
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    if (this.#state !== 'ready') {
      throw new EngineError(`engine ${this.#state}`);
    }
    const state = stateText(request.state, this.#config.maxStateChars);
    this.#detail = undefined;
    try {
      const result = await this.#decideQuestions(request, state, signal);
      this.#state = 'ready';
      return systemOneResponse(this.model, result.answers, result.usage);
    } catch (error) {
      if (!signal.aborted) {
        this.#state = 'failed';
        this.#detail = this.#errorMessage(error);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#state = 'stopped';
    this.#detail = undefined;
  }

  async #decideQuestions(
    request: SystemOneRequest,
    state: string,
    signal: AbortSignal,
  ): Promise<{ readonly answers: Record<string, WireAnswer>; readonly usage: UsageTotals }> {
    const answers: Record<string, WireAnswer> = {};
    const usage: UsageTotals = {};
    for (const [id, question] of Object.entries(request.questions)) {
      signal.throwIfAborted();
      const response = await this.#complete(renderPrompt(question, state), signal);
      addUsage(usage, responseUsage(response));
      this.#addAnswer(answers, id, question, parseTopLogprobs(response));
    }
    return { answers, usage };
  }

  #addAnswer(
    answers: Record<string, WireAnswer>,
    id: string,
    question: Question,
    entries: readonly TopLogprob[],
  ): void {
    if (entries.length === 0) {
      this.#detail = NO_LOGPROBS;
      return;
    }
    const masses = optionMasses(question, entries, this.#config);
    const answer = toWireAnswer(question, masses);
    if (answer !== undefined) {
      answers[id] = answer;
    } else if (masses !== undefined && masses.coverage < masses.minCoverage) {
      this.#detail = lowCoverageDetail(masses.coverage);
    }
  }

  #complete(prompt: RenderedPrompt, signal?: AbortSignal): Promise<unknown> {
    const path = this.#config.api === 'chat' ? '/chat/completions' : '/completions';
    return postJson(endpoint(this.#url, path), requestBody(this.#config, prompt), {
      ...this.#requestOptions(signal),
    });
  }

  #requestOptions(signal?: AbortSignal): JsonRequestOptions {
    const timeout = AbortSignal.timeout(this.#config.requestTimeoutMs);
    return {
      token: this.#token,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      maxBytes: MAX_RESPONSE_BYTES,
      fetch: this.#fetch,
    };
  }

  #errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.#token === undefined || this.#token === ''
      ? message
      : message.replaceAll(this.#token, '[REDACTED]');
  }
}
