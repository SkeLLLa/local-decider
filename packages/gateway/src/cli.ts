#!/usr/bin/env node
import { GatewayClient, parsePolicy, type DecideRequest } from '@local-decider/core';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { bench } from './bench.ts';
import { DEFAULT_PORT, loadConfig, type GatewayConfig } from './config.ts';
import { defaultFlavor, installStrandsEngine, type InstallFlavor } from './engine-install.ts';
import { serveMcpStdio, type McpBackend } from './mcp.ts';
import { resolvePaths, type Paths } from './paths.ts';
import { startGateway } from './runtime.ts';
import {
  detectManager,
  serviceState,
  startService,
  stopService,
  uninstallService,
} from './service.ts';
import { ShadowLog } from './shadow.ts';
import { computeStats, formatStats } from './stats.ts';

const USAGE = `local-decider — local decision models for coding-agent harnesses

Usage:
  local-decider gateway run [--host H] [--port N]   run in the foreground
  local-decider gateway start|restart|stop|status|uninstall  user service (start is a no-op if running)
  local-decider engine install [--flavor cpu|mlx|cuda] [--model ID] [--no-download]
  local-decider decide <policy> [--input JSON] [key=value ...]
  local-decider stats [--json]                      agreement and calibration from the shadow log
  local-decider policies [check <file>]
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
  const config: GatewayConfig = {
    ...ctx.config,
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(values.port === undefined ? {} : { port: Number.parseInt(values.port, 10) }),
  };
  const gateway = await startGateway({ config, paths: ctx.paths });
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

async function engine(ctx: Context): Promise<void> {
  const [sub, ...rest] = ctx.args;
  if (sub !== 'install') {
    throw new UsageError();
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      'flavor': { type: 'string' },
      'model': { type: 'string' },
      'no-download': { type: 'boolean' },
    },
  });
  const flavor = (values.flavor ?? defaultFlavor()) as InstallFlavor;
  if (!['cpu', 'mlx', 'cuda'].includes(flavor)) {
    throw new UsageError();
  }
  const model =
    values['no-download'] === true ? undefined : (values.model ?? ctx.config.engine.model);
  installStrandsEngine(ctx.paths, flavor, model);
  console.log(`strands-decider engine installed (${flavor}) under ${ctx.paths.venvs}`);
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
  const result = computeStats(new ShadowLog(ctx.paths.logs).read());
  console.log(ctx.args.includes('--json') ? JSON.stringify(result, null, 2) : formatStats(result));
}

async function policies(ctx: Context): Promise<void> {
  const [sub, file] = ctx.args;
  if (sub === 'check' && file !== undefined) {
    const policy = parsePolicy(readFileSync(file, 'utf8'), file);
    console.log(
      `${file}: ok (${policy.id}, ${String(Object.keys(policy.questions).length)} questions, ${String(policy.rules.length)} rules)`,
    );
    return;
  }
  const res = await fetch(`${gatewayUrl(ctx.config)}/v1/policies`, {
    signal: AbortSignal.timeout(3000),
  });
  console.log(JSON.stringify(await res.json(), null, 2));
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
    policies,
    bench: benchCmd,
    mcp,
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
    if (error instanceof UsageError) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    console.error(`local-decider: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
