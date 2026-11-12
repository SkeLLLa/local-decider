/** Synthetic, deterministic measurements against a running gateway's `/v1/systemone`. */
import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';

export interface BenchResult {
  readonly targetTokens: number;
  readonly inputTokens: number | undefined;
  readonly runs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly answer: string;
}

export type BenchCall = (
  request: SystemOneRequest,
  signal: AbortSignal,
) => Promise<SystemOneResponse>;

export interface MeasureSizeOptions {
  readonly runs: number;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly onRequest?: () => void;
}

const WORDS =
  'the agent ran the build then the tests passed and it opened a pull request for review'.split(
    ' ',
  );

const QUESTIONS: SystemOneRequest['questions'] = {
  outcome: {
    type: 'choice',
    instructions: 'An autonomous coding agent just ended its turn. Classify the end state.',
    criteria: {
      done: 'The requested work is complete with no open questions.',
      needs_input: 'The agent asks the user a question before it can continue.',
      stuck: 'The agent is looping or gave up partway.',
      failed: 'The agent reports an error or could not do the task.',
    },
  },
};

export function syntheticState(tokens: number): string {
  const out: string[] = [];
  let length = 0;
  for (let i = 0; length < tokens * 4; i++) {
    const word = WORDS[i % WORDS.length] ?? 'x';
    out.push(word);
    length += word.length + 1;
  }
  return `Transcript: ${out.join(' ')}. Final message: All done, the PR is ready.`;
}

export function benchRequest(state: string): SystemOneRequest {
  return { state, questions: QUESTIONS };
}

function pct(sorted: readonly number[], p: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0
  );
}

function httpCall(url: string): BenchCall {
  return async (request, signal) => {
    const res = await fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}: ${await res.text()}`);
    return (await res.json()) as SystemOneResponse;
  };
}

function answerText(response: SystemOneResponse): string {
  const answer = response.answers['outcome'];
  return answer?.type === 'choice' ? answer.choice : '?';
}

export async function measureSize(
  call: BenchCall,
  tokens: number,
  options: MeasureSizeOptions,
): Promise<BenchResult> {
  const state = syntheticState(tokens);
  options.onRequest?.();
  const warm = await call(benchRequest(state), callSignal(options.signal, options.timeoutMs));
  const times = await timedRuns(call, state, options);
  times.sort((a, b) => a - b);
  return {
    targetTokens: tokens,
    inputTokens: warm.usage?.input_tokens,
    runs: options.runs,
    p50Ms: pct(times, 50),
    p95Ms: pct(times, 95),
    answer: answerText(warm),
  };
}

function callSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

async function timedRuns(
  call: BenchCall,
  state: string,
  options: MeasureSizeOptions,
): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < options.runs; i++) {
    options.signal.throwIfAborted();
    options.onRequest?.();
    const started = performance.now();
    await call(
      benchRequest(`${state} (run ${String(i)})`),
      callSignal(options.signal, options.timeoutMs),
    );
    times.push(performance.now() - started);
  }
  return times;
}

export async function bench(
  url: string,
  sizes: readonly number[],
  runs: number,
): Promise<BenchResult[]> {
  const call = httpCall(url);
  const controller = new AbortController();
  const results: BenchResult[] = [];
  for (const tokens of sizes) {
    results.push(
      await measureSize(call, tokens, {
        runs,
        signal: controller.signal,
        timeoutMs: 180_000,
      }),
    );
  }
  return results;
}
