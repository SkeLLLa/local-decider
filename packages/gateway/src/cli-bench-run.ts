/**
 * `local-decider bench`: start a benchmark job on the gateway, follow it, print what finishes and
 * return the exit code. The gateway calls and the process hooks are injected so cli.ts only wires
 * them and tests can run it against a stub server.
 */
import {
  backendWord,
  exitCodeFor,
  formatEndLines,
  formatTarget,
  formatTargetLines,
  parseBenchArgs,
  type BenchArgs,
  type BenchView,
} from './cli-bench.ts';

const TERMINAL = new Set(['done', 'cancelled', 'failed']);
const FINISHED = new Set(['done', 'failed', 'discarded', 'not-run']);

export interface BenchRunDeps {
  readonly args: readonly string[];
  readonly url: string;
  /** A request to the gateway with its credentials; rejects when the gateway is unreachable. */
  readonly request: (
    path: string,
    init: { method?: string; body?: string; timeoutMs: number },
  ) => Promise<Response>;
  /** What to say when the gateway answers 401. */
  readonly refused: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Registers a Ctrl-C handler and returns how to remove it. */
  readonly onInterrupt: (handler: () => void) => () => void;
  /** Leave at once (the second Ctrl-C). */
  readonly exit: (code: number) => void;
  readonly pollMs?: number;
  readonly cancelWaitMs?: number;
  readonly now?: () => number;
}

interface Follow {
  printed: number;
  interruptedAt: number | null;
  stop: boolean;
}

function startBody(args: BenchArgs): string {
  return JSON.stringify({
    ...(args.scope === 'targets' ? { targets: args.targets } : { scope: args.scope }),
    ...(args.family === undefined ? {} : { family: args.family }),
    ...(args.only === undefined ? {} : { only: args.only }),
    sizes: args.sizes,
    runs: args.runs,
    client: 'cli',
  });
}

async function errorOf(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const message = (body as { error?: unknown } | null)?.error;
  return typeof message === 'string' ? message : `gateway answered ${String(res.status)}`;
}

/** A gateway answer as a job view, or exit code 1 after saying why it was refused. */
async function readView(deps: BenchRunDeps, res: Response): Promise<BenchView | number> {
  if (res.status === 401) {
    deps.err(deps.refused);
    return 1;
  }
  if (!res.ok) {
    deps.err(`local-decider: ${await errorOf(res)}`);
    return 1;
  }
  return (await res.json()) as BenchView;
}

/** The started job's view, or the exit code when it did not start. */
async function startJob(deps: BenchRunDeps, args: BenchArgs): Promise<BenchView | number> {
  let res: Response;
  try {
    res = await deps.request('/v1/benchmark', {
      method: 'POST',
      body: startBody(args),
      timeoutMs: 10_000,
    });
  } catch {
    deps.err(`local-decider: gateway not reachable at ${deps.url}; start it first`);
    return 1;
  }
  return readView(deps, res);
}

/** The job's current view, or the exit code when the gateway cannot be read. */
async function poll(deps: BenchRunDeps): Promise<BenchView | number> {
  try {
    return await readView(deps, await deps.request('/v1/benchmark', { timeoutMs: 5000 }));
  } catch {
    deps.err(`local-decider: lost the gateway at ${deps.url}`);
    return 1;
  }
}

/** Prints targets in order as they finish, never one twice. */
function printFinished(deps: BenchRunDeps, view: BenchView, follow: Follow): void {
  const targets = view.targets ?? [];
  const provisional = view.runs != null && view.runs < 3;
  while (follow.printed < targets.length) {
    const t = targets[follow.printed];
    if (t === undefined || !FINISHED.has(t.state ?? '')) {
      return;
    }
    for (const line of formatTargetLines(t, provisional)) deps.out(line);
    follow.printed += 1;
  }
}

function printHeader(deps: BenchRunDeps, args: BenchArgs, view: BenchView): void {
  const targets = view.targets ?? [];
  deps.out(
    `bench ${deps.url} targets=${String(targets.length)} sizes=${args.sizes.join(',')} runs=${String(args.runs)}`,
  );
  for (const t of targets) deps.out(formatTarget(t, backendWord(t)));
}

async function cancelJob(deps: BenchRunDeps): Promise<void> {
  try {
    await deps.request('/v1/benchmark/cancel', { method: 'POST', body: '{}', timeoutMs: 10_000 });
  } catch {
    // The wait below gives up on its own.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ctrl-C: the first cancels the job and waits for it, the second leaves at once. */
function interruptHandler(deps: BenchRunDeps, follow: Follow, now: () => number): () => void {
  return () => {
    if (follow.interruptedAt === null) {
      follow.interruptedAt = now();
      deps.err('local-decider: cancelling the benchmark (Ctrl-C again to leave now)');
      void cancelJob(deps);
      return;
    }
    follow.stop = true;
    deps.exit(130);
  };
}

/**
 * One step of following a running job: the next view to look at, or the exit code when following
 * ends early (the gateway forgot the job, Ctrl-C gave up waiting, or the gateway was lost).
 */
async function step(
  deps: BenchRunDeps,
  view: BenchView,
  follow: Follow,
  now: () => number,
): Promise<BenchView | number> {
  if (view.state === 'idle') {
    deps.err('local-decider: the benchmark is no longer known to the gateway');
    return 1;
  }
  const waited = follow.interruptedAt === null ? 0 : now() - follow.interruptedAt;
  if (follow.stop || waited >= (deps.cancelWaitMs ?? 30_000)) return 130;
  await sleep(deps.pollMs ?? 1000);
  const next = await poll(deps);
  if (typeof next === 'number') return follow.interruptedAt === null ? next : 130;
  return next;
}

/** Prints how the job ended (or the final view with --json) and returns the exit code. */
function finish(deps: BenchRunDeps, args: BenchArgs, view: BenchView, follow: Follow): number {
  if (args.json) deps.out(JSON.stringify(view, null, 2));
  else for (const line of formatEndLines(view)) deps.out(line);
  return exitCodeFor(view, { interrupted: follow.interruptedAt !== null });
}

async function followJob(deps: BenchRunDeps, args: BenchArgs, first: BenchView): Promise<number> {
  const now = deps.now ?? Date.now;
  const follow: Follow = { printed: 0, interruptedAt: null, stop: false };
  const off = deps.onInterrupt(interruptHandler(deps, follow, now));
  try {
    let view = first;
    if (!args.json) printHeader(deps, args, view);
    for (;;) {
      if (!args.json) printFinished(deps, view, follow);
      if (TERMINAL.has(view.state ?? '')) return finish(deps, args, view, follow);
      const next = await step(deps, view, follow, now);
      if (typeof next === 'number') return next;
      view = next;
    }
  } finally {
    off();
  }
}

/** Runs `local-decider bench`; resolves to the process exit code. */
export async function runBench(deps: BenchRunDeps): Promise<number> {
  const parsed = parseBenchArgs(deps.args);
  if (!parsed.ok) {
    deps.err(`local-decider: ${parsed.error}`);
    return parsed.exitCode;
  }
  const started = await startJob(deps, parsed.value);
  return typeof started === 'number' ? started : followJob(deps, parsed.value, started);
}
