#!/usr/bin/env node
import {
  GatewayClient,
  parsePolicy,
  SCOPES,
  type DecideRequest,
  type Scope,
} from '@local-decider/core';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { authoringPrompt } from './authoring.ts';
import { bench } from './bench.ts';
import { EngineInstallUsageError, formatEngineList, planInstall } from './cli-engine.ts';
import { logsCommand } from './cli-logs.ts';
import {
  configCommand,
  configureEngine,
  routingCommand,
  setMode,
  SettingsUsageError,
  useVariant,
} from './cli-settings.ts';
import { ConfigFile } from './config-file.ts';
import { DEFAULT_FLM_MODEL, DEFAULT_PORT, loadConfig, type GatewayConfig } from './config.ts';
import { installStrandsEngine } from './engine-install.ts';
import { hostInfo } from './engines/host.ts';
import { parseEvalCases, runPolicyEval } from './eval.ts';
import { FLM_VERSION, installFlm } from './flm-install.ts';
import { serveMcpStdio, type McpBackend } from './mcp.ts';
import { resolvePaths, type Paths } from './paths.ts';
import { loadPolicies, policyDirs } from './policies.ts';
import { startGateway } from './runtime.ts';
import {
  detectManager,
  serviceState,
  startService,
  stopService,
  uninstallService,
} from './service.ts';
import type { LogStore } from './shadow.ts';
import { openLogStore } from './sqlite-log.ts';
import { computeStats, formatStats } from './stats.ts';

const USAGE = `local-decider — local decision models for coding-agent harnesses

Usage:
  local-decider gateway run [--host H] [--port N]   run in the foreground
  local-decider gateway start|restart|stop|status|uninstall  user service (start is a no-op if running)
  local-decider engine install [--flavor cpu|mlx|cuda] [--model ID] [--no-download]
  local-decider engine install --engine fastflowlm [--model d3:nano]  AMD NPU (Linux)
  local-decider engine list                         list engines and models
  local-decider engine configure <openai-compatible|lmstudio> --url URL --model ID [--token-env NAME]
  local-decider engine use <engine> <model> [--device D]  select an engine and model
  local-decider decide <policy> [--input JSON] [key=value ...]
  local-decider stats [--json] [--scope claude-auto]  agreement and calibration from the shadow log
  local-decider logs backup <file> | export [--since YYYY-MM-DD] <dir> | import <dir>
  local-decider policies [check <file>]             list policies, or validate a policy file
  local-decider policies eval <policy> <file>       report decisions on JSONL fixtures
  local-decider policies use <policy> <variant>     answer <policy> with one of its variants
  local-decider policies mode <policy> off|shadow|act [--scope claude-auto]
  local-decider policies reload                     re-read policy files without a restart
  local-decider policies prompt [policy]            AI prompt for writing your own variant (routing)
  local-decider routing                             preset → model per harness
  local-decider routing map <harness> <preset> [model] [--thinking <level>] [--mode <mode>] [--profile <id>]
  local-decider routing unmap <harness> <preset>
  local-decider config [path|schema [dir]|check|reload]  config.yaml location, JSON Schemas, validation

Settings live in config.yaml (\`local-decider config path\`); the gateway applies edits to it and
to policy files as they happen.
  local-decider bench [--sizes 256,1024,4096] [--runs N]
  local-decider mcp                                 MCP over stdio (proxies to the gateway)

Environment: LOCAL_DECIDER_URL (default http://127.0.0.1:${String(DEFAULT_PORT)}), LOCAL_DECIDER_TOKEN
(bearer for a non-loopback gateway; never logged), LOCAL_DECIDER_HOME, LOCAL_DECIDER_CONFIG_DIR.`;

interface Context {
  readonly paths: Paths;
  readonly config: GatewayConfig;
  readonly args: readonly string[];
}

function gatewayUrl(config: GatewayConfig): string {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  return process.env['LOCAL_DECIDER_URL'] ?? `http://${host}:${String(config.port)}`;
}

function client(config: GatewayConfig, timeoutMs: number): GatewayClient {
  const token = process.env['LOCAL_DECIDER_TOKEN'];
  return new GatewayClient({
    baseUrl: gatewayUrl(config),
    timeoutMs,
    ...(token === undefined ? {} : { token }),
  });
}

async function gatewayRun(ctx: Context): Promise<void> {
  const { values } = parseArgs({
    args: [...ctx.args],
    options: { host: { type: 'string' }, port: { type: 'string' } },
  });
  const store = ConfigFile.open(ctx.paths);
  const config: GatewayConfig = {
    ...store.current,
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(values.port === undefined ? {} : { port: Number.parseInt(values.port, 10) }),
  };
  const gateway = await startGateway({
    config,
    store,
    paths: ctx.paths,
    log: (line) => console.log(line),
  });
  console.log(
    `local-decider gateway on ${gateway.url} (engine ${config.engine.type}, model ${config.engine.model})`,
  );
  console.log(
    `policies: ${[...gateway.decider.policies.values()].map((p) => `${p.policy.id}=${p.mode}`).join(' ')}`,
  );
  const shutdown = (): void => {
    void gateway.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function gatewayService(ctx: Context, action: string): Promise<void> {
  const manager = detectManager();
  if (action === 'start' || action === 'restart') {
    console.log(startService(manager, ctx.paths, action === 'restart'));
  } else if (action === 'stop') {
    console.log(stopService(manager, ctx.paths));
  } else if (action === 'uninstall') {
    console.log(uninstallService(manager, ctx.paths));
  } else {
    const health = await client(ctx.config, 2000).health();
    console.log(`service (${manager}): ${serviceState(manager, ctx.paths)}`);
    console.log(
      `gateway ${gatewayUrl(ctx.config)}: ${health === null ? 'unreachable' : JSON.stringify(health)}`,
    );
  }
}

async function installFastFlowLM(model: string | undefined, noDownload: boolean): Promise<void> {
  const flm = await installFlm(resolvePaths());
  console.log(`FastFlowLM ${FLM_VERSION} installed: ${flm}`);
  execFileSync(flm, ['validate'], { stdio: 'inherit' });
  if (!noDownload) {
    execFileSync(flm, ['pull', model ?? DEFAULT_FLM_MODEL], { stdio: 'inherit' });
  }
  console.log(
    'Switch to it: Settings → Local decider, or POST /v1/engine {"engine":"fastflowlm","model":"d3:nano"}',
  );
}

async function listEngines(ctx: Context): Promise<void> {
  const payload = await client(ctx.config, 5000).engines();
  if (payload === null) {
    console.error(`gateway unreachable at ${gatewayUrl(ctx.config)}`);
    process.exitCode = 1;
    return;
  }
  console.log(formatEngineList(payload));
}

function parseUseSelection(args: readonly string[]): {
  engine: string;
  model: string;
  device?: string;
} {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { device: { type: 'string' } },
      allowPositionals: true,
    });
    const [engineName, model, ...extra] = parsed.positionals;
    if (engineName === undefined || model === undefined || extra.length > 0) {
      throw new UsageError();
    }
    return {
      engine: engineName,
      model,
      ...(parsed.values.device === undefined ? {} : { device: parsed.values.device }),
    };
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }
    throw new UsageError();
  }
}

function printSelectionResult(
  result: Exclude<Awaited<ReturnType<GatewayClient['selectEngine']>>, null>,
  engineName: string,
  model: string,
): void {
  if (result.status < 200 || result.status >= 300) {
    return printGatewayError(result.body);
  }
  const body = responseRecord(result.body);
  const selectedEngine = selectionValue(body, 'engine', engineName);
  const selectedModel = selectionValue(body, 'model', model);
  console.log(`selected ${selectedEngine} ${selectedModel}`);
}

function responseRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function selectionValue(body: Record<string, unknown>, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : fallback;
}

function printGatewayError(value: unknown): void {
  const body = responseRecord(value);
  const error = body['error'];
  console.error(typeof error === 'string' ? error : JSON.stringify(body));
  process.exitCode = 1;
}

async function useEngine(ctx: Context, args: readonly string[]): Promise<void> {
  const selection = parseUseSelection(args);
  const result = await client(ctx.config, 30_000).selectEngine(selection);
  if (result === null) {
    console.error(`gateway unreachable at ${gatewayUrl(ctx.config)}`);
    process.exitCode = 1;
    return;
  }
  printSelectionResult(result, selection.engine, selection.model);
}

async function installEngine(ctx: Context, args: readonly string[]): Promise<void> {
  const plan = planInstall(args, hostInfo(), ctx.config.engine.type, ctx.config.engine.model);
  if (plan.engine === 'fastflowlm') {
    return installFastFlowLM(plan.model, plan.noDownload);
  }
  installStrandsEngine(ctx.paths, plan.flavor, plan.model);
  console.log(`strands-decider engine installed (${plan.flavor}) under ${ctx.paths.venvs}`);
}

async function engine(ctx: Context): Promise<void> {
  const [sub, ...rest] = ctx.args;
  if (sub === 'list') {
    return listEngines(ctx);
  }
  if (sub === 'use') {
    return useEngine(ctx, rest);
  }
  if (sub === 'configure') {
    console.log(configureEngine(ctx.paths, rest));
    return;
  }
  if (sub === 'install') {
    return installEngine(ctx, rest);
  }
  throw new UsageError();
}

function parseInput(args: readonly string[]): DecideRequest['input'] {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { input: { type: 'string' } },
    allowPositionals: true,
  });
  const input: Record<string, unknown> =
    values.input === undefined ? {} : (JSON.parse(values.input) as Record<string, unknown>);
  for (const pair of positionals) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new UsageError();
    }
    input[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return input;
}

async function decide(ctx: Context): Promise<void> {
  const [policy, ...rest] = ctx.args;
  if (policy === undefined) {
    throw new UsageError();
  }
  const result = await client(ctx.config, ctx.config.decisionTimeoutMs).decide(policy, {
    harness: 'cli',
    input: parseInput(rest),
  });
  if (result === null) {
    throw new Error(
      `no decision: gateway at ${gatewayUrl(ctx.config)} unreachable or returned an error`,
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

async function stats(ctx: Context): Promise<void> {
  const { values } = parseArgs({
    args: [...ctx.args],
    options: { json: { type: 'boolean' }, scope: { type: 'string' } },
  });
  if (values.scope !== undefined && !(SCOPES as readonly string[]).includes(values.scope)) {
    throw new SettingsUsageError(`scope must be one of ${SCOPES.join(', ')}`);
  }
  const log = await openLogStore(ctx.paths, ctx.config.logs.store, {
    readOnly: true,
    autoImport: false,
  });
  try {
    const result = computeStats(
      log.read(),
      ctx.config.pricing,
      loadPolicies(ctx.config, policyDirs(ctx.config, ctx.paths)),
      values.scope === undefined ? {} : { scope: values.scope as Scope },
    );
    console.log(values.json === true ? JSON.stringify(result, null, 2) : formatStats(result));
  } finally {
    closeLogStore(log);
  }
}

function closeLogStore(log: LogStore): void {
  const closable = log as LogStore & { close?: () => void };
  closable.close?.();
}

function checkPolicy(file: string): void {
  const policy = parsePolicy(readFileSync(file, 'utf8'), file);
  const variant = policy.variantOf === undefined ? '' : `, variant of ${policy.variantOf}`;
  console.log(
    `${file}: ok (${policy.id}${variant}, ${String(Object.keys(policy.questions).length)} questions, ${String(policy.rules.length)} rules)`,
  );
}

/** POST a control route and print the answer; a gateway error becomes the exit message. */
async function gatewayPost(ctx: Context, path: string, body: unknown): Promise<void> {
  const token = process.env['LOCAL_DECIDER_TOKEN'];
  const res = await fetch(`${gatewayUrl(ctx.config)}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (answer as { error?: unknown } | null)?.error;
    throw new Error(
      typeof message === 'string' ? message : `gateway answered ${String(res.status)}`,
    );
  }
  console.log(JSON.stringify(answer, null, 2));
}

type PolicySubcommand = (
  ctx: Context,
  first: string | undefined,
  second: string | undefined,
) => Promise<void>;

function requiredPolicyArg(value: string | undefined): string {
  if (value === undefined) {
    throw new UsageError();
  }
  return value;
}

async function evalPolicy(
  ctx: Context,
  policy: string | undefined,
  file: string | undefined,
): Promise<void> {
  const path = requiredPolicyArg(file);
  const cases = parseEvalCases(readFileSync(path, 'utf8'), path);
  const gw = client(ctx.config, ctx.config.decisionTimeoutMs);
  await runPolicyEval(requiredPolicyArg(policy), cases, (id, request) => gw.decide(id, request));
}

async function promptPolicy(ctx: Context, policy: string | undefined): Promise<void> {
  const loaded = loadPolicies(ctx.config, policyDirs(ctx.config, ctx.paths));
  process.stdout.write(authoringPrompt(policy ?? 'routing', loaded, ctx.paths));
}

async function listPolicies(ctx: Context): Promise<void> {
  const res = await fetch(`${gatewayUrl(ctx.config)}/v1/policies`, {
    signal: AbortSignal.timeout(3000),
  });
  console.log(JSON.stringify(await res.json(), null, 2));
}

const POLICY_SUBCOMMANDS: Readonly<Record<string, PolicySubcommand>> = {
  check: async (_ctx, first) => checkPolicy(requiredPolicyArg(first)),
  eval: evalPolicy,
  prompt: promptPolicy,
  use: async (ctx, first, second) =>
    console.log(useVariant(ctx.paths, requiredPolicyArg(first), requiredPolicyArg(second))),
  mode: async (ctx, first, second) => {
    const { values } = parseArgs({
      args: ctx.args.slice(1),
      options: { scope: { type: 'string' } },
      allowPositionals: true,
    });
    console.log(
      setMode(ctx.paths, requiredPolicyArg(first), requiredPolicyArg(second), values.scope),
    );
  },
  reload: async (ctx) => gatewayPost(ctx, '/v1/policies/reload', {}),
};

async function policies(ctx: Context): Promise<void> {
  const [sub, first, second] = ctx.args;
  if (sub === undefined) {
    return listPolicies(ctx);
  }
  const handler = POLICY_SUBCOMMANDS[sub];
  if (handler === undefined) {
    throw new UsageError();
  }
  await handler(ctx, first, second);
}

async function benchCmd(ctx: Context): Promise<void> {
  const { values } = parseArgs({
    args: [...ctx.args],
    options: { sizes: { type: 'string' }, runs: { type: 'string' } },
  });
  const sizes = (values.sizes ?? '256,1024,4096').split(',').map((s) => Number.parseInt(s, 10));
  const runs = Number.parseInt(values.runs ?? '10', 10);
  const url = gatewayUrl(ctx.config);
  console.log(`bench ${url} model=${ctx.config.engine.model} runs=${String(runs)}`);
  for (const r of await bench(url, sizes, runs)) {
    console.log(
      `${String(r.targetTokens).padStart(5)} tok (engine ${String(r.inputTokens ?? '?')}): p50 ${r.p50Ms.toFixed(0)} ms, p95 ${r.p95Ms.toFixed(0)} ms, answer=${r.answer}`,
    );
  }
}

async function mcp(ctx: Context): Promise<void> {
  const gw = client(ctx.config, ctx.config.decisionTimeoutMs);
  const backend: McpBackend = {
    async decide(policy, request) {
      const result = await gw.decide(policy, request);
      if (result === null) {
        throw new Error('local-decider gateway unreachable');
      }
      return result;
    },
    async listPolicies() {
      const res = await fetch(`${gatewayUrl(ctx.config)}/v1/policies`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.json();
    },
  };
  await serveMcpStdio(backend);
}

class UsageError extends Error {}

async function dispatch(command: string | undefined, ctx: Context): Promise<void> {
  if (command === 'gateway') {
    const [action, ...rest] = ctx.args;
    if (action === 'run') {
      return gatewayRun({ ...ctx, args: rest });
    }
    if (
      action === 'start' ||
      action === 'restart' ||
      action === 'stop' ||
      action === 'status' ||
      action === 'uninstall'
    ) {
      return gatewayService(ctx, action);
    }
    throw new UsageError();
  }
  const commands: Record<string, (ctx: Context) => Promise<void>> = {
    engine,
    decide,
    stats,
    logs: (c) => logsCommand(c.paths, c.config, c.args),
    policies,
    bench: benchCmd,
    mcp,
    config: async (c) =>
      c.args[0] === 'reload'
        ? gatewayPost(c, '/v1/config/reload', {})
        : console.log(configCommand(c.paths, c.args)),
    routing: async (c) => console.log(routingCommand(c.paths, c.args)),
  };
  const handler = command === undefined ? undefined : commands[command];
  if (handler === undefined) {
    throw new UsageError();
  }
  return handler(ctx);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }
  const paths = resolvePaths();
  try {
    await dispatch(command, { paths, config: loadConfig(paths), args });
  } catch (error) {
    if (error instanceof EngineInstallUsageError) {
      console.error(`local-decider: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof UsageError || error instanceof SettingsUsageError) {
      console.error(error.message === '' ? USAGE : `local-decider: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`local-decider: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
