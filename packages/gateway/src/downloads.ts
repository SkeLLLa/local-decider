import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ModelDescriptor } from './engines/descriptor.ts';
import { stripAnsi, type Toolchain } from './toolchain.ts';

export interface Download {
  readonly id: string;
  readonly engine: string;
  readonly model: string;
  state: 'running' | 'done' | 'failed';
  readonly startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** 0..1 when the tool prints percentages, else null. */
  progress: number | null;
}

export class DownloadError extends Error {
  override readonly name = 'DownloadError';
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** Fixed argv per step. Model ids and repos come from the catalogue, never from a request. */
export function downloadSteps(model: ModelDescriptor, tools: Toolchain): [string, string[]][] {
  if (model.engine === 'fastflowlm') {
    if (tools.flm === undefined) {
      throw new DownloadError(409, 'FastFlowLM is not installed');
    }
    return [[tools.flm, ['pull', model.id]]];
  }
  const hf =
    tools.strandsDecider === undefined ? undefined : join(dirname(tools.strandsDecider), 'hf');
  if (hf === undefined || !existsSync(hf)) {
    throw new DownloadError(
      409,
      'the strands-decider engine is not installed; run `local-decider engine install`',
    );
  }
  return (model.artifacts ?? []).map((artifact): [string, string[]] => [
    hf,
    ['download', artifact],
  ]);
}

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%/g;

/** Last percentage in a chunk of tool output, as 0..1. */
export function lastPercent(text: string): number | null {
  let last: number | null = null;
  for (const match of text.matchAll(PERCENT)) {
    const value = Number.parseFloat(match[1] ?? '');
    if (value >= 0 && value <= 100) {
      last = value / 100;
    }
  }
  return last;
}

function runStep(
  cmd: string,
  args: string[],
  env: Readonly<Record<string, string>>,
  onOutput: (text: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let tail = '';
    const take = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-2000);
      onOutput(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const lines = stripAnsi(tail)
        .trim()
        .split(/[\r\n]+/);
      reject(new Error(lines.at(-1) ?? `exit code ${String(code)}`));
    });
  });
}

/** Model downloads, one job per model at a time; finished jobs stay listed until restart. */
export class Downloads {
  readonly #jobs = new Map<string, Download>();
  #seq = 0;

  list(): Download[] {
    return [...this.#jobs.values()];
  }

  running(model: string): boolean {
    return this.list().some((d) => d.model === model && d.state === 'running');
  }

  start(model: ModelDescriptor, tools: Toolchain, onDone: () => void): Download {
    if (this.running(model.id)) {
      throw new DownloadError(409, `${model.id} is already downloading`);
    }
    const steps = downloadSteps(model, tools);
    this.#seq += 1;
    const job: Download = {
      id: `dl-${String(this.#seq)}`,
      engine: model.engine,
      model: model.id,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      progress: null,
    };
    this.#jobs.set(job.id, job);
    void this.#run(job, steps, tools.env).finally(onDone);
    return job;
  }

  async #run(
    job: Download,
    steps: [string, string[]][],
    env: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      for (const [i, [cmd, args]] of steps.entries()) {
        await runStep(cmd, args, env, (text) => {
          const p = lastPercent(text);
          if (p !== null) {
            job.progress = (i + p) / steps.length;
          }
        });
      }
      job.state = 'done';
      job.progress = 1;
    } catch (error) {
      job.state = 'failed';
      job.error = (error as Error).message.slice(0, 300);
    }
    job.finishedAt = new Date().toISOString();
  }
}
