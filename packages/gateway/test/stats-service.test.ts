import type { LogRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadPolicies, policyDirs } from '../src/policies.ts';
import { startGateway } from '../src/runtime.ts';
import { openLogStore } from '../src/sqlite-log.ts';
import { runStats, runStatsFromFile } from '../src/stats-job.ts';
import { StatsFailedError, StatsService, StatsTimeoutError } from '../src/stats-service.ts';
import { FakeEngine, tempLog, tempPaths, testConfig } from './helpers.ts';

const DAY = 86_400_000;

function decision(id: string, ageDays: number): LogRecord {
  return {
    kind: 'decision',
    ts: new Date(Date.now() - ageDays * DAY).toISOString(),
    decisionId: id,
    harness: 'cli',
    policy: 'permission',
    mode: 'shadow',
    inputHash: 'h',
    answers: {
      verdict: {
        type: 'choice',
        answer: 'allow',
        probabilities: { allow: 0.95, ask: 0.05 },
        confidence: 0.9,
      },
    },
    action: 'allow',
    enforced: false,
    engine: 'fake',
    model: 'm',
    latencyMs: 5,
  };
}

function seeded(): ReturnType<typeof tempPaths> {
  const paths = tempPaths();
  const log = openLogStore(paths);
  for (const [id, age] of [
    ['new1', 1],
    ['new2', 5],
    ['old', 60],
  ] as const) {
    log.append(decision(id, age));
  }
  log.close();
  return paths;
}

const decisions = (r: { decisions: number }[]): number | undefined => r[0]?.decisions;

describe('StatsService', () => {
  it('computes in-process for an injected store, honouring the window', async () => {
    const log = tempLog();
    log.append(decision('a', 1));
    log.append(decision('b', 60));
    const service = new StatsService({ log });
    assert.equal(decisions(await service.compute({ days: 30 })), 1);
    assert.equal(decisions(await service.compute({ days: 90 })), 2);
    log.close();
  });

  it('worker result equals the in-process result on the same db file', async () => {
    const paths = seeded();
    const policies = loadPolicies(testConfig(), policyDirs(testConfig(), paths));
    const job = { days: 30, policies };
    const viaWorker = await new StatsService({ log: tempLog(), paths }).compute(job);
    const log = openLogStore(paths, { readOnly: true });
    const inProcess = runStats(log, job);
    log.close();
    assert.equal(decisions(viaWorker), 2);
    assert.deepEqual(viaWorker, JSON.parse(JSON.stringify(inProcess)));
  });

  it('shares an in-flight run and serialises distinct ones', async () => {
    const paths = seeded();
    const service = new StatsService({ log: tempLog(), paths });
    const a = service.compute({ days: 30 });
    const b = service.compute({ days: 30 });
    const c = service.compute({ days: 90 });
    assert.equal(a, b);
    assert.equal(decisions(await a), 2);
    assert.equal(decisions(await c), 3);
  });

  it('times out and terminates a slow worker', async () => {
    const service = new StatsService({
      log: tempLog(),
      paths: seeded(),
      timeoutMs: 100,
      workerFile: new URL('./fixtures/slow-worker.mjs', import.meta.url),
    });
    await assert.rejects(service.compute({ days: 30 }), StatsTimeoutError);
  });

  it('reports a failing worker generically but keeps the open failure as detail', async () => {
    const service = new StatsService({ log: tempLog(), paths: tempPaths() });
    await assert.rejects(service.compute({ days: 30 }), (error: unknown) => {
      assert.ok(error instanceof StatsFailedError);
      assert.equal(error.message, 'stats computation failed');
      assert.match(error.detail ?? '', /does not exist/);
      return true;
    });
  });

  it('close terminates the active worker, fails queued runs and refuses new ones', async () => {
    const service = new StatsService({
      log: tempLog(),
      paths: seeded(),
      timeoutMs: 60_000,
      workerFile: new URL('./fixtures/slow-worker.mjs', import.meta.url),
    });
    const active = service.compute({ days: 30 });
    const queued = service.compute({ days: 90 });
    const settled = [
      assert.rejects(active, StatsFailedError),
      assert.rejects(queued, StatsFailedError),
    ];
    service.close();
    await Promise.all(settled);
    await assert.rejects(service.compute({ days: 30 }), StatsFailedError);
  });
});

describe('runStatsFromFile', () => {
  it('reads as empty stats when the database file does not exist yet', () => {
    const paths = tempPaths();
    const log = tempLog();
    const job = { days: 30 };
    assert.deepEqual(runStatsFromFile(paths, job), runStats(log, job));
    log.close();
  });
});

describe('GET /v1/stats?days=', () => {
  it('windows records, defaults to 30 and rejects bad input', async () => {
    const paths = seeded();
    const gw = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine(),
      env: {},
    });
    try {
      const get = async (q: string): Promise<Response> => fetch(`${gw.url}/v1/stats${q}`);
      assert.equal(decisions((await (await get('')).json()) as { decisions: number }[]), 2);
      assert.equal(decisions((await (await get('?days=90')).json()) as { decisions: number }[]), 3);
      assert.equal(decisions((await (await get('?days=2')).json()) as { decisions: number }[]), 1);
      for (const bad of ['0', '-1', 'x', '1.5', '366', '']) {
        assert.equal((await get(`?days=${bad}`)).status, 400, bad);
      }
    } finally {
      await gw.close();
    }
  });
});
