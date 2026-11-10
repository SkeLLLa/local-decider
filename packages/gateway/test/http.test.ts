import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { postSystemOne } from '../src/engines/http.ts';
import { EngineError } from '../src/engines/types.ts';

const request = { questions: {}, state: '' };

/** A `fetch` answering every call with `body`, streamed in `chunks` pieces. */
function fakeFetch(body: string, chunks = 1, status = 200): typeof fetch {
  return async () => {
    const bytes = new TextEncoder().encode(body);
    const size = Math.ceil(bytes.length / chunks);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(sent, sent + size));
        sent += size;
      },
    });
    return new Response(stream, { status });
  };
}

describe('postSystemOne', () => {
  const signal = new AbortController().signal;

  it('parses a streamed response', async () => {
    const body = JSON.stringify({ answers: { verdict: { answer: 'allow' } } });
    const res = await postSystemOne(
      { baseUrl: 'http://127.0.0.1:1', fetch: fakeFetch(body, 4) },
      request,
      signal,
    );
    assert.deepEqual(res.answers, { verdict: { answer: 'allow' } });
  });

  it('refuses a response over 1 MiB without reading all of it', async () => {
    const body = 'x'.repeat(2 * 1024 * 1024);
    await assert.rejects(
      postSystemOne({ baseUrl: 'http://127.0.0.1:1', fetch: fakeFetch(body, 64) }, request, signal),
      (error: unknown) => error instanceof EngineError && /too large/.test(error.message),
    );
  });

  it('reports the status and the start of the body on an HTTP error', async () => {
    await assert.rejects(
      postSystemOne(
        { baseUrl: 'http://127.0.0.1:1', fetch: fakeFetch('model not loaded', 1, 503) },
        request,
        signal,
      ),
      /engine HTTP 503: model not loaded/,
    );
  });
});
