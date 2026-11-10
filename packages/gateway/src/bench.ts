/**
 * Latency benchmark against a running gateway's `/v1/systemone` (M1: p50/p95 at 256, 1k and 4k
 * tokens). State is synthetic, deterministic text sized by the gateway's 4-chars-per-token
 * estimate; the engine's own `usage.input_tokens` is reported alongside.
 */
import type { SystemOneResponse } from '@local-decider/core';

export interface BenchResult {
  readonly targetTokens: number;
  readonly inputTokens: number | undefined;
  readonly runs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly answer: string;
}

const WORDS =
  'the agent ran the build then the tests passed and it opened a pull request for review'.split(
    ' ',
  );

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

const QUESTIONS = {
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
} as const;

function pct(sorted: readonly number[], p: number): number {
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0
  );
}

async function once(url: string, state: string): Promise<{ ms: number; body: SystemOneResponse }> {
  const started = performance.now();
  const res = await fetch(`${url}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, questions: QUESTIONS }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${String(res.status)}: ${await res.text()}`);
  }
  const body = (await res.json()) as SystemOneResponse;
  return { ms: performance.now() - started, body };
}

export async function bench(
  url: string,
  sizes: readonly number[],
  runs: number,
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const tokens of sizes) {
    const state = syntheticState(tokens);
    const warm = await once(url, state);
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      times.push((await once(url, `${state} (run ${String(i)})`)).ms);
    }
    const sorted = times.toSorted((a, b) => a - b);
    const answer = warm.body.answers['outcome'];
    results.push({
      targetTokens: tokens,
      inputTokens: warm.body.usage?.input_tokens,
      runs,
      p50Ms: pct(sorted, 50),
      p95Ms: pct(sorted, 95),
      answer: answer?.type === 'choice' ? answer.choice : '?',
    });
  }
  return results;
}
