/**
 * The hook runner's core: hook stdin → (guard, gateway policy) → harness stdout. No process I/O
 * here; `main.ts` wires stdin/stdout/env. Every failure path returns empty stdout and exit 0.
 */
import {
  commandOf,
  DEFAULT_GATEWAY_URL,
  GatewayClient,
  isShellTool,
  str,
  type DecideRequest,
  type DecideResponse,
  type HookInput,
} from '@ziptie-soft/local-decider-core';

import { guardCommand } from './guard.ts';
import {
  callOf,
  EVENT_POLICY,
  mapEvent,
  parseEvent,
  parseHarness,
  type HookEvent,
  type HookHarness,
  type ReadTranscript,
} from './mapping.ts';
import { guardDeny, translate } from './output.ts';
import { readSlice } from './transcript.ts';

export type Env = Readonly<Record<string, string | undefined>>;
export type Decide = (policy: string, request: DecideRequest) => Promise<DecideResponse | null>;

export interface RunDeps {
  /** Gateway call; defaults to a `GatewayClient` configured from `env`. */
  readonly decide?: Decide;
  readonly readTranscript?: ReadTranscript;
  /** Diagnostics sink, used only when `LOCAL_DECIDER_DEBUG=1`. */
  readonly stderr?: (line: string) => void;
}

export interface RunResult {
  readonly stdout: string;
  readonly exitCode: 0;
}

const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Comma list of policies a host already runs for this session, set by the Paseo plugin on the
 * agents it launches. The hooks skip those so one event gets one decision; the guard and any
 * policy not listed still run.
 */
const HOST_POLICIES_ENV = 'LOCAL_DECIDER_HOST_POLICIES';
const NOTHING: RunResult = { stdout: '', exitCode: 0 };

export function timeoutOf(env: Env): number {
  const n = Number(env['LOCAL_DECIDER_TIMEOUT_MS']);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function clientFromEnv(env: Env): Decide {
  const token = str(env['LOCAL_DECIDER_TOKEN']);
  const client = new GatewayClient({
    baseUrl: str(env['LOCAL_DECIDER_URL']) ?? DEFAULT_GATEWAY_URL,
    timeoutMs: timeoutOf(env),
    ...(token === undefined ? {} : { token }),
  });
  return async (policy, request) => client.decide(policy, request);
}

function parseHook(stdinText: string): HookInput | null {
  try {
    const value: unknown = JSON.parse(stdinText);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as HookInput)
      : null;
  } catch {
    return null;
  }
}

function hostRuns(env: Env, policy: string): boolean {
  return (env[HOST_POLICIES_ENV] ?? '').split(',').some((p) => p.trim() === policy);
}

function guardOutput(hook: HookInput, env: Env): string {
  if (env['LOCAL_DECIDER_GUARD'] === 'off' || !isShellTool(hook)) {
    return '';
  }
  const command = commandOf(hook);
  const hit = command === undefined ? null : guardCommand(command);
  return hit === null ? '' : guardDeny(hit);
}

interface Context {
  readonly harness: HookHarness;
  readonly event: HookEvent;
  readonly hook: HookInput;
  readonly env: Env;
  readonly deps: RunDeps;
  readonly log: (msg: string) => void;
}

async function decideAndTranslate(ctx: Context): Promise<string> {
  const call = mapEvent(ctx.event, ctx.hook, ctx.deps.readTranscript ?? readSlice);
  const sessionId = str(ctx.hook['session_id']);
  const toolCall = callOf(ctx.harness, ctx.event, ctx.hook);
  const request: DecideRequest = {
    harness: ctx.harness === 'claude' ? 'claude-code' : 'codex',
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(toolCall === undefined ? {} : { call: toolCall }),
    input: call.input,
  };
  const decide = ctx.deps.decide ?? clientFromEnv(ctx.env);
  const res = await decide(call.policy, request);
  ctx.log(
    res === null
      ? `${call.policy}: no answer (gateway down, slow or erroring); abstaining`
      : `${call.policy}: action=${res.action} enforced=${String(res.enforced)} id=${res.decisionId}`,
  );
  return translate(ctx.harness, ctx.event, res, ctx.hook['permission_mode'] === 'auto');
}

async function handle(ctx: Context): Promise<string> {
  if (ctx.event === 'PreToolUse') {
    const denied = guardOutput(ctx.hook, ctx.env);
    if (denied !== '') {
      ctx.log('guard deny');
      return denied;
    }
  }
  if (ctx.event === 'Stop' && ctx.hook['stop_hook_active'] === true) {
    ctx.log('stop_hook_active: skipping');
    return '';
  }
  const policy = EVENT_POLICY[ctx.event];
  if (hostRuns(ctx.env, policy)) {
    ctx.log(`${policy}: run by the host (${HOST_POLICIES_ENV}); skipping`);
    return '';
  }
  return decideAndTranslate(ctx);
}

function logger(env: Env, deps: RunDeps): (msg: string) => void {
  if (env['LOCAL_DECIDER_DEBUG'] !== '1') {
    return () => undefined;
  }
  const sink = deps.stderr ?? ((line: string) => void process.stderr.write(line));
  return (msg) => {
    sink(`local-decider: ${msg}\n`);
  };
}

/** Run one hook invocation. Never throws; any failure abstains (empty stdout, exit 0). */
export async function run(
  harnessName: string,
  eventName: string,
  stdinText: string,
  env: Env,
  deps: RunDeps = {},
): Promise<RunResult> {
  const log = logger(env, deps);
  try {
    const harness = parseHarness(harnessName);
    const event = parseEvent(eventName);
    const hook = parseHook(stdinText);
    if (harness === undefined || event === undefined || hook === null) {
      log(`ignoring ${harnessName} ${eventName} (unknown harness/event or bad stdin)`);
      return NOTHING;
    }
    const stdout = await handle({ harness, event, hook, env, deps, log });
    return { stdout, exitCode: 0 };
  } catch (error) {
    log(`error, failing open: ${error instanceof Error ? error.message : String(error)}`);
    return NOTHING;
  }
}
