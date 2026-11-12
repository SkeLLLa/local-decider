import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import type { SystemOneRequest, SystemOneResponse } from '@ziptie-soft/local-decider-core';

import { bench, benchRequest, measureSize, syntheticState } from '../src/bench.ts';

const RESPONSE: SystemOneResponse = {
  answers: { outcome: { type: 'choice', choice: 'done', probabilities: { done: 1 } } },
  usage: { input_tokens: 73 },
};

describe('benchmark core', () => {
  it('builds the decision request and deterministic synthetic state', () => {
    assert.equal(benchRequest('state').state, 'state');
    assert.ok(benchRequest('state').questions['outcome']);
    assert.ok(syntheticState(64).startsWith('Transcript:'));
  });

  it('excludes warm-up, keeps run suffixes and reports nearest-rank percentiles', async () => {
    const states: string[] = [];
    const call = async (request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> => {
      signal.throwIfAborted();
      assert.equal(typeof request.state, 'string');
      if (typeof request.state === 'string') states.push(request.state);
      return RESPONSE;
    };
    let requests = 0;
    const result = await measureSize(call, 64, {
      runs: 3,
      signal: new AbortController().signal,
      timeoutMs: 1000,
      onRequest: () => requests++,
    });
    assert.equal(states.length, 4);
    assert.equal(states[0]?.endsWith('(run 0)'), false);
    assert.ok(states[1]?.endsWith('(run 0)'));
    assert.ok(states[3]?.endsWith('(run 2)'));
    assert.equal(requests, 4);
    assert.equal(result.runs, 3);
    assert.equal(result.inputTokens, 73);
    assert.equal(result.answer, 'done');
    assert.ok(result.p50Ms >= 0);
    assert.ok(result.p95Ms >= result.p50Ms);
  });

  it('stops before a timed request when the signal is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const call = async (_request: SystemOneRequest, _signal: AbortSignal): Promise<SystemOneResponse> => {
      calls++;
      controller.abort();
      return RESPONSE;
    };
    await assert.rejects(
      measureSize(call, 64, { runs: 3, signal: controller.signal, timeoutMs: 1000 }),
      { name: 'AbortError' },
    );
    assert.equal(calls, 1);
  });

  describe('bench against HTTP', () => {
    let server: ReturnType<typeof createServer>;
    let url = '';

    before(async () => {
      server = createServer((_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(RESPONSE));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    });
    after(() => server.close());

    it('measures each requested size against the stub server', async () => {
      const result = await bench(url, [64], 2);
      assert.equal(result.length, 1);
      assert.equal(result[0]?.targetTokens, 64);
      assert.equal(result[0]?.runs, 2);
      assert.equal(result[0]?.answer, 'done');
    });
  });
});
