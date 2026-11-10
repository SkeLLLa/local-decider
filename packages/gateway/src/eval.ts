import type { DecideRequest, DecideResponse } from '@local-decider/core';

export interface PolicyEvalCase {
  readonly input: DecideRequest['input'];
  readonly expect: string;
}

export type EvalDecide = (policy: string, request: DecideRequest) => Promise<DecideResponse | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse JSONL `{input, expect}` records, identifying malformed lines for CLI users. */
export function parseEvalCases(source: string, file = '<eval>'): PolicyEvalCase[] {
  const cases: PolicyEvalCase[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    const text = line.trim();
    if (text === '') {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${file}:${String(index + 1)}: invalid JSON`);
    }
    if (!isRecord(value) || !isRecord(value['input']) || typeof value['expect'] !== 'string') {
      throw new Error(`${file}:${String(index + 1)}: expected { input: object, expect: string }`);
    }
    cases.push({ input: value['input'], expect: value['expect'] });
  }
  return cases;
}

/** Report one model decision per fixture; mismatches never affect the caller's exit status. */
export async function runPolicyEval(
  policy: string,
  cases: readonly PolicyEvalCase[],
  decide: EvalDecide,
  report: (line: string) => void = console.log,
): Promise<void> {
  for (const [index, testCase] of cases.entries()) {
    const result = await decisionOrNull(decide, policy, testCase.input);
    const answer = result === null ? undefined : Object.values(result.answers)[0];
    const probability = answer === undefined ? null : (answer.probabilities[answer.answer] ?? 0);
    report(
      `${String(index + 1)} expected=${testCase.expect} action=${result?.action ?? 'unavailable'} p=${probability === null ? '-' : probability.toFixed(3)}`,
    );
  }
}

async function decisionOrNull(
  decide: EvalDecide,
  policy: string,
  input: DecideRequest['input'],
): Promise<DecideResponse | null> {
  try {
    return await decide(policy, { harness: 'cli', input });
  } catch {
    return null;
  }
}
