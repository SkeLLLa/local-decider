import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { describe, it } from 'node:test';

import { runBench, type BenchRunDeps } from '../src/cli-bench-run.ts';
import type { BenchView } from '../src/cli-bench.ts';

const PENDING_A = {
  engine: 'fastflowlm',
  model: 'd3:lite',
  device: null,
  state: 'pending',
  sizes: [],
};
const PENDING_B = {
  engine: 'llama-vulkan',
  model: 'd3-lite-q8_0',
  device: null,
  state: 'pending',
  sizes: [],
};
const TARGETS = [PENDING_A, PENDING_B];

function done(state: string, restored = true): BenchView {
  return {
    state,
    runs: 5,
    restoredOk: restored,
    restore: { engine: 'fastflowlm', model: 'd3:nano' },
    targets: [
      {
        ...PENDING_A,
        state: 'done',
        loadMs: 4200,
        sizes: [
          {
            targetTokens: 256,
            inputTokens: 301,
            p50Ms: 220,
            p95Ms: 240,
            answer: 'done',
            error: null,
          },
        ],
      },
      { ...PENDING_B, state: 'failed', error: 'out of memory', sizes: [] },
    ],
  };
}

interface Stub {
  readonly url: string;
  readonly calls: { method: string; path: string; body: unknown }[];
  close(): Promise<void>;
}

/** A gateway stand-in: `start` answers the POST, `views` are returned by successive GETs. */
async function stub(
  start: { status: number; body: unknown },
  views: readonly unknown[],
): Promise<Stub> {
  const calls: Stub['calls'] = [];
  let next = 0;
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: raw === '' ? null : JSON.parse(raw),
      });
      const [status, body] =
        req.method === 'POST' && req.url === '/v1/benchmark'
          ? [start.status, start.body]
          : [200, views[Math.min(next++, views.length - 1)]];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const noop = (): void => undefined;

function run(
  gateway: Stub | null,
  args: string[],
  over: Partial<BenchRunDeps> = {},
): {
  result: Promise<number>;
  out: string[];
  err: string[];
  exits: number[];
  interrupt: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const hooks: { handler: () => void } = { handler: noop };
  const url = gateway?.url ?? 'http://127.0.0.1:1';
  const result = runBench({
    args,
    url,
    request: (path, init) =>
      fetch(`${url}${path}`, {
        method: init.method ?? 'GET',
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(init.timeoutMs),
      }),
    refused: 'local-decider: gateway refused: control token missing or wrong',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    onInterrupt: (h) => {
      hooks.handler = h;
      return () => {
        hooks.handler = noop;
      };
    },
    exit: (code) => exits.push(code),
    pollMs: 5,
    ...over,
  });
  return {
    result,
    out,
    err,
    exits,
    interrupt: () => {
      hooks.handler();
    },
  };
}

describe('runBench', () => {
  it('starts the job, prints the header and each finished target once, and exits 0', async () => {
    const running = { ...done('running'), targets: TARGETS };
    const half = {
      ...done('running'),
      targets: [done('running').targets?.[0], TARGETS[1]],
    };
    const gw = await stub({ status: 202, body: running }, [running, half, half, done('done')]);
    try {
      const { result, out, err } = run(gw, ['--installed', '--sizes', '256', '--runs', '5']);
      assert.equal(await result, 0);
      assert.deepEqual(err, []);
      assert.deepEqual(out, [
        `bench ${gw.url} targets=2 sizes=256 runs=5`,
        'fastflowlm d3:lite (NPU)',
        'llama-vulkan d3-lite-q8_0 (Vulkan)',
        'fastflowlm d3:lite (NPU)',
        '  load 4.2 s',
        '  256 tok (engine 301): p50 220 ms, p95 240 ms, answer=done',
        'llama-vulkan d3-lite-q8_0 (Vulkan)',
        '  failed: out of memory',
        'restored fastflowlm d3:nano',
      ]);
      const start = gw.calls[0];
      assert.equal(start?.method, 'POST');
      assert.equal(start?.path, '/v1/benchmark');
      assert.deepEqual(start?.body, { scope: 'installed', sizes: [256], runs: 5, client: 'cli' });
    } finally {
      await gw.close();
    }
  });

  it('sends explicit targets and --missing, without a scope', async () => {
    const gw = await stub({ status: 202, body: { ...done('done') } }, [done('done')]);
    try {
      const { result } = run(gw, [
        '--engines',
        'fastflowlm:d3:lite,strands-decider:m@cuda',
        '--missing',
      ]);
      await result;
      assert.deepEqual(gw.calls[0]?.body, {
        targets: [
          { engine: 'fastflowlm', model: 'd3:lite' },
          { engine: 'strands-decider', model: 'm', device: 'cuda' },
        ],
        only: 'missing',
        sizes: [256, 1024, 3800],
        runs: 5,
        client: 'cli',
      });
    } finally {
      await gw.close();
    }
  });

  it('prints only the final view as JSON with --json', async () => {
    const gw = await stub({ status: 202, body: { ...done('running'), targets: TARGETS } }, [
      done('running'),
      done('done'),
    ]);
    try {
      const { result, out } = run(gw, ['--json']);
      assert.equal(await result, 0);
      assert.equal(out.length, 1);
      assert.deepEqual(JSON.parse(out[0] ?? ''), done('done'));
    } finally {
      await gw.close();
    }
  });

  it('exits 1 with the gateway message when it refuses (409), 401, or is down', async () => {
    const busy = await stub(
      { status: 409, body: { error: 'a benchmark is already running (bench-3)' } },
      [],
    );
    try {
      const { result, err, out } = run(busy, ['--installed']);
      assert.equal(await result, 1);
      assert.deepEqual(err, ['local-decider: a benchmark is already running (bench-3)']);
      assert.deepEqual(out, []);
    } finally {
      await busy.close();
    }
    const denied = await stub({ status: 401, body: { error: 'control token required' } }, []);
    try {
      const { result, err } = run(denied, []);
      assert.equal(await result, 1);
      assert.deepEqual(err, ['local-decider: gateway refused: control token missing or wrong']);
    } finally {
      await denied.close();
    }
    const down = run(null, []);
    assert.equal(await down.result, 1);
    assert.deepEqual(down.err, [
      'local-decider: gateway not reachable at http://127.0.0.1:1; start it first',
    ]);
  });

  it('exits 2 on a usage error without calling the gateway', async () => {
    const gw = await stub({ status: 202, body: {} }, []);
    try {
      for (const args of [
        ['--installed', '--family', 'x'],
        ['--sizes', 'a'],
        ['--engines', 'nope:m'],
      ]) {
        const { result, err } = run(gw, args);
        assert.equal(await result, 2);
        assert.equal(err.length, 1);
        assert.match(err[0] ?? '', /^local-decider: /);
      }
      assert.deepEqual(gw.calls, []);
    } finally {
      await gw.close();
    }
  });

  it('cancels on the first Ctrl-C, waits for the end and exits 130, removing its handler', async () => {
    const running = { ...done('running'), targets: TARGETS };
    const cancelled = { ...done('cancelled'), cancelReason: 'user' };
    const gw = await stub({ status: 202, body: running }, [running, running, cancelled]);
    try {
      const { result, out, interrupt } = run(gw, ['--installed']);
      await new Promise((resolve) => setTimeout(resolve, 20));
      interrupt();
      assert.equal(await result, 130);
      assert.ok(gw.calls.some((c) => c.method === 'POST' && c.path === '/v1/benchmark/cancel'));
      assert.ok(out.includes('cancelled (user)'));
    } finally {
      await gw.close();
    }
  });

  it('leaves at once on the second Ctrl-C, and gives up after the cancel wait', async () => {
    const running = { ...done('running'), targets: TARGETS };
    const gw = await stub({ status: 202, body: running }, [running]);
    try {
      const twice = run(gw, ['--installed']);
      await new Promise((resolve) => setTimeout(resolve, 15));
      twice.interrupt();
      twice.interrupt();
      assert.equal(await twice.result, 130);
      assert.deepEqual(twice.exits, [130]);
      const slow = run(gw, ['--installed'], { cancelWaitMs: 30 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      slow.interrupt();
      assert.equal(await slow.result, 130);
    } finally {
      await gw.close();
    }
  });
});
