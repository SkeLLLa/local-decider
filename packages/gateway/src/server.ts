import {
  HARNESSES,
  policyRoutes,
  type DecideRequest,
  type DecisionModels,
  type OutcomeRecord,
  type SystemOneRequest,
  type UsageRecord,
} from '@local-decider/core';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { totalmem } from 'node:os';

import type { GatewayConfig } from './config.ts';
import { UnknownPolicyError, type Decider } from './decider.ts';
import { DownloadError } from './downloads.ts';
import {
  EngineSwitchError,
  parseLifecycle,
  parseMode,
  parsePathUpdate,
  parseSelection,
  parseVariant,
  type EngineControl,
} from './engine-control.ts';
import { handleMcpHttp } from './mcp.ts';
import { KNOWN_MODELS, modelFits } from './models.ts';
import { withConfiguredRoutes, withRoute } from './routing.ts';
import type { Pricing } from './savings.ts';
import { settingsHandler } from './settings-routes.ts';
import type { ShadowLog } from './shadow.ts';
import { computeStats } from './stats.ts';

const MAX_BODY_BYTES = 256 * 1024;

export interface ServerOptions {
  readonly decider: Decider;
  readonly log: ShadowLog;
  /** Required bearer token, or undefined for loopback-only no-auth mode. */
  readonly token?: string | undefined;
  /** Runtime model switching; absent in tests that inject an engine. */
  readonly engineControl?: EngineControl | undefined;
  /** Optional price table: stats then add dollar estimates to token savings. */
  readonly pricing?: Pricing | undefined;
  /** Live settings (config.yaml as last loaded): routing presets and pricing. */
  readonly settings?: (() => GatewayConfig) | undefined;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'request body too large');
    }
    chunks.push(buf);
  }
  if (size === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecideRequest(body: unknown): DecideRequest {
  if (!isRecord(body) || !isRecord(body['input'])) {
    throw new HttpError(400, 'expected {harness, input: object}');
  }
  const harness = body['harness'];
  if (typeof harness !== 'string' || !(HARNESSES as readonly string[]).includes(harness)) {
    throw new HttpError(400, `harness must be one of ${HARNESSES.join(', ')}`);
  }
  const sessionId =
    typeof body['sessionId'] === 'string' ? body['sessionId'].slice(0, 200) : undefined;
  const models = parseModels(body['models']);
  return {
    harness: harness as DecideRequest['harness'],
    input: body['input'],
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(models === undefined ? {} : { models }),
  };
}

/** `provider/model` ids: logged and matched against the price table, never used otherwise. */
const MODEL_ID = /^[\w.:@+/[\]-]{1,200}$/;
const MAX_ROUTES = 20;

function modelId(value: unknown): string | undefined {
  return typeof value === 'string' && MODEL_ID.test(value) ? value : undefined;
}

/** Tolerant: an invalid `models` field is dropped, never a 400, so decisions still run. */
function parseModels(value: unknown): DecisionModels | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const requested = modelId(value['requested']);
  const routes: Record<string, string> = {};
  const rawRoutes = isRecord(value['routes']) ? value['routes'] : {};
  for (const [action, model] of Object.entries(rawRoutes).slice(0, MAX_ROUTES)) {
    const id = modelId(model);
    if (id !== undefined && action.length <= 100) {
      routes[action] = id;
    }
  }
  const hasRoutes = Object.keys(routes).length > 0;
  if (requested === undefined && !hasRoutes) {
    return undefined;
  }
  return { ...(requested === undefined ? {} : { requested }), ...(hasRoutes ? { routes } : {}) };
}

function parseSystemOne(body: unknown): SystemOneRequest {
  if (!isRecord(body) || !isRecord(body['questions']) || !('state' in body)) {
    throw new HttpError(400, 'expected {state, questions}');
  }
  return body as unknown as SystemOneRequest;
}

function parseOutcome(body: unknown): OutcomeRecord {
  if (
    !isRecord(body) ||
    typeof body['decisionId'] !== 'string' ||
    typeof body['outcome'] !== 'string'
  ) {
    throw new HttpError(400, 'expected {decisionId, outcome, source?}');
  }
  const source = body['source'];
  return {
    kind: 'outcome',
    ts: new Date().toISOString(),
    decisionId: body['decisionId'].slice(0, 100),
    outcome: body['outcome'].slice(0, 100),
    source: source === 'harness' || source === 'heuristic' ? source : 'user',
  };
}

/** A token count: a finite, non-negative integer below 10^12. */
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1e12
    ? value
    : undefined;
}

function parseUsage(body: unknown): UsageRecord {
  const input = isRecord(body) ? count(body['inputTokens']) : undefined;
  const output = isRecord(body) ? count(body['outputTokens']) : undefined;
  if (
    !isRecord(body) ||
    typeof body['decisionId'] !== 'string' ||
    input === undefined ||
    output === undefined
  ) {
    throw new HttpError(
      400,
      'expected {decisionId, inputTokens, outputTokens, cachedInputTokens?, turnId?, model?, costUsd?}',
    );
  }
  const turnId = typeof body['turnId'] === 'string' ? body['turnId'].slice(0, 200) : undefined;
  const model = modelId(body['model']);
  const cost = body['costUsd'];
  return {
    kind: 'usage',
    ts: new Date().toISOString(),
    decisionId: body['decisionId'].slice(0, 100),
    ...(turnId === undefined ? {} : { turnId }),
    ...(model === undefined ? {} : { model }),
    inputTokens: input,
    cachedInputTokens: count(body['cachedInputTokens']) ?? 0,
    outputTokens: output,
    ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost < 1e6
      ? { costUsd: cost }
      : {}),
  };
}

function authorised(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  const header = req.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostname(value: string): string {
  if (value.startsWith('[')) {
    return value.slice(0, value.indexOf(']') + 1);
  }
  return value.split(':')[0] ?? '';
}

function originIsLoopback(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Browser defences for the unauthenticated loopback mode. A web page can reach 127.0.0.1 with
 * "simple" cross-origin requests (text/plain POSTs skip the CORS preflight) and through DNS
 * rebinding (a hostile domain resolving to 127.0.0.1). So without a token: the Host header must
 * be loopback, a browser Origin must be loopback, and every POST must be application/json,
 * which forces a preflight this server never answers. Returns an error message, or undefined.
 */
function browserGuard(req: IncomingMessage, token: string | undefined): string | undefined {
  if (token !== undefined) {
    return undefined;
  }
  if (!LOOPBACK_HOSTS.has(hostname(req.headers.host ?? ''))) {
    return 'host not allowed';
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !originIsLoopback(origin)) {
    return 'cross-origin requests are not allowed';
  }
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (req.method === 'POST' && type !== 'application/json') {
    return 'POST bodies must be application/json';
  }
  return undefined;
}

/** Abort when the client goes away, so queued decisions for dead callers are skipped. */
function requestSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return controller.signal;
}

function health(decider: Decider): Record<string, unknown> {
  const engine = decider.engine.health();
  // A lazily unloaded engine is healthy: it loads on the next decision.
  const status =
    engine.state === 'ready' || engine.onDemand === true
      ? 'ok'
      : engine.state === 'starting'
        ? 'degraded'
        : 'down';
  return {
    status,
    engine: decider.engine.id,
    engineState: engine.state,
    model: engine.model,
    ...(engine.detail === undefined ? {} : { detail: engine.detail }),
    ...(engine.maxLength === undefined ? {} : { maxLength: engine.maxLength }),
    p50Ms: decider.latency(50),
    p95Ms: decider.latency(95),
    queueDepth: decider.queueDepth,
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse, options: ServerOptions) => Promise<void>;
type ControlHandler = (
  req: IncomingMessage,
  control: EngineControl,
  decider: Decider,
) => Promise<[number, unknown]>;

const policyRoute = /^\/v1\/policies\/([a-z][a-z0-9_-]{0,63})\/(mode|variant)$/;

/** Engine, model, lifecycle, download, validation, path and policy routes. */
const CONTROL_ROUTES: Readonly<Record<string, ControlHandler>> = {
  'GET /v1/engines': async (_req, c) => [200, await c.status()],
  'POST /v1/engine': async (req, c, d) => {
    const selection = await c.select(parseSelection(await readJson(req)));
    return [200, { ...selection, state: d.engine.health().state }];
  },
  'POST /v1/engine/load': async (_req, c, d) => {
    await c.load();
    return [202, { state: d.engine.health().state }];
  },
  'POST /v1/engine/unload': async (_req, c, d) => {
    await c.unload();
    return [200, { state: d.engine.health().state }];
  },
  'POST /v1/engine/lifecycle': async (req, c) => [
    200,
    c.setLifecycle(parseLifecycle(await readJson(req))),
  ],
  'POST /v1/models/download': async (req, c) => {
    const body = await readJson(req);
    const record = isRecord(body) ? body : {};
    return [202, { download: c.download(String(record['engine']), String(record['model'])) }];
  },
  'POST /v1/engines/validate': async (req, c) => {
    const body = await readJson(req);
    return [200, { validation: await c.validate(String(isRecord(body) ? body['engine'] : '')) }];
  },
  'POST /v1/paths': async (req, c) => {
    const { key, value } = parsePathUpdate(await readJson(req));
    return [200, await c.setPath(key, value)];
  },
  'POST /v1/policies/reload': async (_req, c) => [200, { policies: c.reloadPolicies() }],
};

/** `POST /v1/policies/:id/mode` and `/variant`. */
function policyHandler(id: string, field: string): ControlHandler {
  if (field === 'mode') {
    return async (req, c) => {
      const mode = parseMode(await readJson(req));
      c.setPolicyMode(id, mode);
      return [200, { id, mode }];
    };
  }
  return async (req, c) => {
    const variant = parseVariant(await readJson(req));
    c.setPolicyVariant(id, variant);
    return [200, { id, variant }];
  };
}

/** Settings routes (settings-routes.ts) take the parsed body instead of the request. */
function fromSettings(key: string, path: string): ControlHandler | undefined {
  const settings = settingsHandler(key, path);
  return settings === undefined
    ? undefined
    : async (req, c, d) =>
        settings(key.startsWith('POST ') ? await readJson(req) : undefined, c, d);
}

function controlRoute(key: string, path: string): Handler | undefined {
  const match = key.startsWith('POST ') ? policyRoute.exec(path) : null;
  const handler: ControlHandler | undefined =
    match?.[1] === undefined || match[2] === undefined
      ? (CONTROL_ROUTES[key] ?? fromSettings(key, path))
      : policyHandler(match[1], match[2]);
  if (handler === undefined) {
    return undefined;
  }
  return async (req, res, { decider, engineControl }) => {
    if (engineControl === undefined) {
      throw new EngineSwitchError(409, 'this engine cannot switch models at runtime');
    }
    const [status, body] = await handler(req, engineControl, decider);
    send(res, status, body);
  };
}

const decideRoute = /^\/v1\/decide\/([a-z][a-z0-9_-]{0,63})$/;

function route(method: string, path: string): Handler | undefined {
  const key = `${method} ${path}`;
  if (key === 'GET /health' || key === 'GET /ping') {
    return async (_req, res, { decider }) => send(res, 200, health(decider));
  }
  if (key === 'GET /models') {
    return async (_req, res, { decider, engineControl }) =>
      send(res, 200, {
        active: decider.engine.model,
        engine: decider.engine.id,
        device: engineControl?.current()?.device ?? null,
        switchable: engineControl?.switchable ?? false,
        totalMemoryGb: Math.round(totalmem() / 1e9),
        models: KNOWN_MODELS.map((m) => ({ ...m, fits: modelFits(m.id, totalmem()) })),
      });
  }
  const control = controlRoute(key, path);
  if (control !== undefined) {
    return control;
  }
  if (key === 'GET /v1/policies') {
    return async (_req, res, { decider }) =>
      send(
        res,
        200,
        [...decider.policies.values()].map(({ policy, mode }) => ({
          id: policy.id,
          mode,
          description: policy.description,
          inputKeys: policy.state.sections.map((s) => s.from),
          routes: policyRoutes(policy),
          ...(policy.variantOf === undefined
            ? { variant: decider.activeVariant(policy.id), variants: decider.variantsOf(policy.id) }
            : { variantOf: policy.variantOf }),
        })),
      );
  }
  if (key === 'GET /v1/stats') {
    return async (_req, res, { log, pricing, settings }) =>
      send(res, 200, computeStats(log.read(), settings?.().pricing ?? pricing));
  }
  if (key === 'POST /v1/systemone' || key === 'POST /invocations') {
    return async (req, res, { decider }) =>
      send(
        res,
        200,
        await decider.systemOne(parseSystemOne(await readJson(req)), requestSignal(res)),
      );
  }
  if (key === 'POST /v1/usage') {
    return async (req, res, { log }) => {
      log.append(parseUsage(await readJson(req)));
      send(res, 200, { ok: true });
    };
  }
  if (key === 'POST /v1/outcomes') {
    return async (req, res, { log }) => {
      log.append(parseOutcome(await readJson(req)));
      send(res, 200, { ok: true });
    };
  }
  if (path === '/mcp') {
    return async (req, res, { decider }) =>
      handleMcpHttp(decider, req, res, method === 'POST' ? await readJson(req) : undefined);
  }
  const match = method === 'POST' ? decideRoute.exec(path) : null;
  const policy = match?.[1];
  if (policy !== undefined) {
    return async (req, res, { decider, settings }) => {
      const config = settings?.();
      const parsed = parseDecideRequest(await readJson(req));
      const request = config === undefined ? parsed : withConfiguredRoutes(config, parsed);
      const response = await decider.decide(policy, request, requestSignal(res));
      send(
        res,
        200,
        config === undefined ? response : withRoute(config, request.harness, response),
      );
    };
  }
  return undefined;
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (
    error instanceof HttpError ||
    error instanceof EngineSwitchError ||
    error instanceof DownloadError
  ) {
    send(res, error.status, { error: error.message });
  } else if (error instanceof UnknownPolicyError) {
    send(res, 404, { error: error.message });
  } else {
    send(res, 502, { error: error instanceof Error ? error.message : 'engine error' });
  }
}

export function createGatewayServer(options: ServerOptions): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!authorised(req, options.token)) {
      send(res, 401, { error: 'unauthorised' });
      return;
    }
    const refused = browserGuard(req, options.token);
    if (refused !== undefined) {
      send(res, 403, { error: refused });
      return;
    }
    const handler = route(req.method ?? 'GET', path);
    if (handler === undefined) {
      send(res, 404, { error: 'not found' });
      return;
    }
    handler(req, res, options).catch((error: unknown) => sendError(res, error));
  });
}
