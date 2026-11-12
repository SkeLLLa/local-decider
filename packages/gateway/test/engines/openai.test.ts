import type { Question } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { describe, it } from 'node:test';

import {
  openaiCompatibleEngine,
  OpenAICompatibleEngine,
  lmStudioSchema,
  type OpenAICompatibleEngineConfig,
} from '../../src/engines/openai/index.ts';
import type { TopLogprob } from '../../src/engines/openai/logprob.ts';
import { EngineError } from '../../src/engines/types.ts';

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

interface ServerContext {
  readonly url: string;
  close(): Promise<void>;
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function serverContext(handler: RequestHandler): Promise<ServerContext> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}

async function withServer(
  handler: RequestHandler,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const context = await serverContext(handler);
  try {
    await run(context.url);
  } finally {
    await context.close();
  }
}

function config(url: string, values: Record<string, unknown> = {}): OpenAICompatibleEngineConfig {
  return openaiCompatibleEngine.configSchema.parse({
    type: 'openai-compatible',
    model: 'test-model',
    url,
    ...values,
  });
}

function lmConfig(url: string, values: Record<string, unknown> = {}): OpenAICompatibleEngineConfig {
  return lmStudioSchema.parse({ type: 'lmstudio', model: 'test-model', url, ...values });
}

function logprob(token: string, probability: number): TopLogprob {
  return { token, logprob: Math.log(probability) };
}

function chatResponse(
  entries: readonly TopLogprob[],
  usage = { prompt_tokens: 7, completion_tokens: 1 },
): Record<string, unknown> {
  return {
    choices: [{ logprobs: { content: [{ top_logprobs: entries }] } }],
    usage,
  };
}

function chatUser(body: Record<string, unknown>): string {
  const messages = body['messages'];
  const user = Array.isArray(messages) ? messages[1] : undefined;
  const record = typeof user === 'object' && user !== null ? (user as Record<string, unknown>) : {};
  return typeof record['content'] === 'string' ? record['content'] : '';
}

function fakeFetch(seen: (string | null)[]): typeof fetch {
  return async (input, init) => {
    seen.push(new Headers(init?.headers).get('authorization'));
    const requestUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(requestUrl).pathname;
    const body = path.endsWith('/models')
      ? { data: [] }
      : chatResponse([logprob('yes', 0.8), logprob('no', 0.2)]);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
}

function near(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-10);
}

describe('OpenAI-compatible engine', () => {
  it('adds LM Studio template options while leaving generic requests unchanged', async () => {
    for (const [engineConfig, expectedMax, lmStudio] of [
      [(url: string) => config(url, { maxTokens: 8 }), 8, false],
      [(url: string) => lmConfig(url, { maxTokens: 8 }), 12, true],
    ] as const) {
      const bodies: Record<string, unknown>[] = [];
      await withServer(
        (request, response) => {
          void readJson(request).then((body) => {
            bodies.push(body);
            json(response, chatResponse([logprob('yes', 0.8), logprob('no', 0.2)]));
          });
        },
        async (url) => {
          const engine = new OpenAICompatibleEngine(engineConfig(url));
          await engine.start();
          const body = bodies[0];
          assert.equal(body?.['max_tokens'], expectedMax);
          assert.equal(body?.['chat_template_kwargs'] === undefined, !lmStudio);
          if (lmStudio) {
            assert.deepEqual(body?.['chat_template_kwargs'], { enable_thinking: false });
          }
          await engine.stop();
        },
      );
    }
  });

  it('uses the planned defaults and is selectable', () => {
    const parsed = config('http://127.0.0.1:1234/v1');
    assert.equal(parsed.api, 'chat');
    assert.equal(parsed.maxTokens, 1);
    assert.equal(parsed.topLogprobs, 10);
    assert.equal(parsed.maxOptions, 10);
    assert.equal(parsed.minCoverage, 0.5);
    assert.equal(openaiCompatibleEngine.selectable, true);
  });

  it('is ready from the logprob probe even when the server does not support /models', async () => {
    const paths: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    await withServer(
      (request, response) => {
        paths.push(request.url ?? '');
        if (request.method === 'GET') {
          response.writeHead(501).end();
          return;
        }
        void readJson(request).then((body) => {
          bodies.push(body);
          json(response, chatResponse([logprob('yes', 0.8), logprob('no', 0.2)]));
        });
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(
          config(url, { maxTokens: 8, promptSuffix: '/no_think' }),
        );
        await engine.start();
        assert.deepEqual(paths, ['/v1/chat/completions']);
        assert.equal(engine.health().state, 'ready');
        assert.equal(bodies[0]?.['model'], 'test-model');
        assert.equal(bodies[0]?.['max_tokens'], 8);
        assert.equal(bodies[0]?.['logprobs'], true);
        assert.equal(bodies[0]?.['top_logprobs'], 10);
        assert.match(chatUser(bodies[0] ?? {}), /\/no_think$/);
      },
    );
  });

  it('reports a clear startup error when the probe returns null logprobs', async () => {
    await withServer(
      (request, response) => {
        if (request.method === 'GET') {
          json(response, { data: [] });
        } else {
          json(response, { choices: [{ logprobs: null }] });
        }
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(config(url));
        await engine.start();
        assert.equal(engine.health().state, 'failed');
        assert.match(engine.health().detail ?? '', /server returned no logprobs/);
        assert.match(engine.health().detail ?? '', /use engine lmstudio/);
      },
    );
  });

  it('decides questions sequentially and sums token usage', async () => {
    const bodies: Record<string, unknown>[] = [];
    const choice: Question = {
      type: 'choice',
      instructions: 'Which option applies?',
      criteria: { allow: 'Safe request', deny: 'Unsafe request' },
    };
    const noul: Question = { type: 'noul', instructions: 'Is the state ready?' };
    await withServer(
      (request, response) => {
        if (request.method === 'GET') {
          json(response, { data: [] });
          return;
        }
        void readJson(request).then((body) => {
          bodies.push(body);
          const user = chatUser(body);
          const entries = user.includes('Question: Which option applies?')
            ? [logprob('A', 0.8), logprob('B', 0.2)]
            : [logprob('yes', 0.7), logprob('no', 0.3)];
          json(response, chatResponse(entries));
        });
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(config(url));
        await engine.start();
        const result = await engine.decide(
          {
            state: { z: 1, a: 'safe' },
            questions: { verdict: choice, ready: noul },
          },
          new AbortController().signal,
        );
        assert.equal(result.model, 'test-model');
        assert.equal(result.answers['verdict']?.type, 'choice');
        if (result.answers['verdict']?.type === 'choice') {
          assert.equal(result.answers['verdict'].choice, 'allow');
          near(result.answers['verdict'].probabilities['allow'], 0.8);
        }
        assert.equal(result.answers['ready']?.type, 'noul');
        if (result.answers['ready']?.type === 'noul') {
          near(result.answers['ready'].noul, 0.7);
        }
        assert.deepEqual(result.usage, { input_tokens: 14, output_tokens: 2 });
        assert.equal(bodies.length, 3); // probe, then one call per question
        assert.match(chatUser(bodies[1] ?? {}), /\{"a":"safe","z":1\}/);
      },
    );
  });

  it('uses the legacy completions request and response shape when configured', async () => {
    let body: Record<string, unknown> | undefined;
    await withServer(
      (request, response) => {
        if (request.method === 'GET') {
          json(response, { data: [] });
          return;
        }
        void readJson(request).then((requestBody) => {
          body = requestBody;
          json(response, {
            choices: [{ logprobs: { top_logprobs: [{ yes: Math.log(0.8), no: Math.log(0.2) }] } }],
          });
        });
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(
          config(url, { api: 'completions', maxTokens: 8, promptSuffix: '/no_think' }),
        );
        await engine.start();
        const result = await engine.decide(
          {
            state: 'safe',
            questions: { ready: { type: 'noul', instructions: 'Is it ready?' } },
          },
          new AbortController().signal,
        );
        assert.deepEqual(result.answers['ready'], { type: 'noul', noul: 0.8 });
        assert.equal(typeof body?.['prompt'], 'string');
        assert.match(String(body?.['prompt']), /Answer:\n\/no_think$/);
        assert.equal(body?.['max_tokens'], 8);
        assert.equal(body?.['logprobs'], 10);
        assert.equal(body?.['messages'], undefined);
      },
    );
  });

  it('sends tokens only to loopback or HTTPS targets', async () => {
    const loopbackHeaders: (string | null)[] = [];
    await withServer(
      (request, response) => {
        if (request.method === 'GET') {
          loopbackHeaders.push(request.headers.authorization ?? null);
          json(response, { data: [] });
        } else {
          loopbackHeaders.push(request.headers.authorization ?? null);
          void readJson(request).then(() =>
            json(response, chatResponse([logprob('yes', 0.8), logprob('no', 0.2)])),
          );
        }
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(config(url, { tokenEnv: 'OPENAI_TEST_TOKEN' }), {
          OPENAI_TEST_TOKEN: 'local-secret',
        });
        await engine.start();
        assert.deepEqual(loopbackHeaders, ['Bearer local-secret']);
      },
    );

    const insecureHeaders: (string | null)[] = [];
    const insecure = new OpenAICompatibleEngine(
      config('http://192.0.2.10/v1', { tokenEnv: 'OPENAI_TEST_TOKEN' }),
      { OPENAI_TEST_TOKEN: 'remote-secret' },
      fakeFetch(insecureHeaders),
    );
    await insecure.start();
    assert.deepEqual(insecureHeaders, [null]);

    const secureHeaders: (string | null)[] = [];
    const secure = new OpenAICompatibleEngine(
      config('https://inference.example.test/v1', { tokenEnv: 'OPENAI_TEST_TOKEN' }),
      { OPENAI_TEST_TOKEN: 'secure-secret' },
      fakeFetch(secureHeaders),
    );
    await secure.start();
    assert.deepEqual(secureHeaders, ['Bearer secure-secret']);
  });

  it('redacts a token echoed by an HTTP error before rethrowing', async () => {
    let calls = 0;
    const token = 'openai-test-secret';
    await withServer(
      (request, response) => {
        calls += 1;
        if (calls === 1) {
          void readJson(request).then(() =>
            json(response, chatResponse([logprob('yes', 0.8), logprob('no', 0.2)])),
          );
          return;
        }
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.end(`unauthorized bearer ${token}`);
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(config(url, { tokenEnv: 'OPENAI_TEST_TOKEN' }), {
          OPENAI_TEST_TOKEN: token,
        });
        await engine.start();
        await assert.rejects(
          engine.decide(
            {
              state: 'safe',
              questions: { ready: { type: 'noul', instructions: 'Is it ready?' } },
            },
            new AbortController().signal,
          ),
          (error: unknown) =>
            error instanceof EngineError &&
            !error.message.includes(token) &&
            error.message.includes('[REDACTED]'),
        );
        assert.ok(!engine.health().detail?.includes(token));
      },
    );
  });

  it('hides URL credentials and query values from the no-server detail', async () => {
    const secretUrl = 'https://user:SECRETPW@127.0.0.1:1/v1?key=SECRETQ';
    const engine = new OpenAICompatibleEngine(config(secretUrl), {}, async () => {
      throw new TypeError('fetch failed');
    });
    await engine.start();
    const detail = engine.health().detail ?? '';
    assert.match(detail, /https:\/\/127\.0\.0\.1:1\/v1/);
    assert.equal(detail.includes('SECRETPW'), false);
    assert.equal(detail.includes('SECRETQ'), false);
  });

  it('honours an aborted decision signal', async () => {
    let postCount = 0;
    let receivedResolve: (() => void) | undefined;
    const decisionReceived = new Promise<void>((resolve) => {
      receivedResolve = resolve;
    });
    await withServer(
      (request, response) => {
        if (request.method === 'GET') {
          json(response, { data: [] });
          return;
        }
        postCount += 1;
        if (postCount === 1) {
          void readJson(request).then(() =>
            json(response, chatResponse([logprob('yes', 0.8), logprob('no', 0.2)])),
          );
          return;
        }
        void readJson(request).then(() => receivedResolve?.());
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(config(url));
        await engine.start();
        const controller = new AbortController();
        const decision = engine.decide(
          {
            state: 'safe',
            questions: { ready: { type: 'noul', instructions: 'Is it ready?' } },
          },
          controller.signal,
        );
        await decisionReceived;
        controller.abort();
        await assert.rejects(decision, (error: unknown) => error instanceof EngineError);
        assert.equal(engine.health().state, 'ready');
      },
    );
  });

  it('caps responses at one MiB', async () => {
    await withServer(
      (request, response) => {
        void readJson(request).then(() => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            `{"choices":[{"logprobs":{"content":[{"top_logprobs":${' '.repeat(1024 * 1024)}}]}}]}`,
          );
        });
      },
      async (url) => {
        const engine = new OpenAICompatibleEngine(config(url));
        await engine.start();
        assert.equal(engine.health().state, 'failed');
        assert.match(engine.health().detail ?? '', /engine response too large/);
      },
    );
  });
});
