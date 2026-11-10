import {
  HARNESSES,
  type DecideRequest,
  type OutcomeRecord,
  type SystemOneRequest,
} from '@local-decider/core';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { UnknownPolicyError, type Decider } from './decider.ts';
import { handleMcpHttp } from './mcp.ts';
import { KNOWN_MODELS } from './models.ts';
import type { ShadowLog } from './shadow.ts';
import { computeStats } from './stats.ts';

export const MAX_BODY_BYTES = 256 * 1024;

export interface ServerOptions {
  readonly decider: Decider;
  readonly log: ShadowLog;
  /** Required bearer token, or undefined for loopback-only no-auth mode. */
  readonly token?: string | undefined;
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
  return {
    harness: harness as DecideRequest['harness'],
    input: body['input'],
    ...(sessionId === undefined ? {} : { sessionId }),
  };
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

function authorised(req: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  const header = req.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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
  const status =
    engine.state === 'ready' ? 'ok' : engine.state === 'starting' ? 'degraded' : 'down';
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

const decideRoute = /^\/v1\/decide\/([a-z][a-z0-9_-]{0,63})$/;

function route(method: string, path: string): Handler | undefined {
  const key = `${method} ${path}`;
  if (key === 'GET /health' || key === 'GET /ping') {
    return async (_req, res, { decider }) => send(res, 200, health(decider));
  }
  if (key === 'GET /models') {
    return async (_req, res, { decider }) =>
      send(res, 200, {
        active: decider.engine.model,
        engine: decider.engine.id,
        models: KNOWN_MODELS,
      });
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
        })),
      );
  }
  if (key === 'GET /v1/stats') {
    return async (_req, res, { log }) => send(res, 200, computeStats(log.read()));
  }
  if (key === 'POST /v1/systemone' || key === 'POST /invocations') {
    return async (req, res, { decider }) =>
      send(
        res,
        200,
        await decider.systemOne(parseSystemOne(await readJson(req)), requestSignal(res)),
      );
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
    return async (req, res, { decider }) =>
      send(
        res,
        200,
        await decider.decide(policy, parseDecideRequest(await readJson(req)), requestSignal(res)),
      );
  }
  return undefined;
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
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
    const handler = route(req.method ?? 'GET', path);
    if (handler === undefined) {
      send(res, 404, { error: 'not found' });
      return;
    }
    handler(req, res, options).catch((error: unknown) => sendError(res, error));
  });
}
