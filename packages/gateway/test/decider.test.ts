import { parsePolicy, type LogRecord, type Mode } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Decider, QUEUE_MAX, renderValue, UnknownPolicyError } from '../src/decider.ts';
import { ManagedEngine } from '../src/engines/lazy.ts';
import type { Engine } from '../src/engines/types.ts';
import type { LogStore } from '../src/log-store.ts';
import { defaultPolicyDir, type LoadedPolicy } from '../src/policies.ts';
import { FakeEngine, tempLog } from './helpers.ts';

function policies(mode: Mode, ttlSeconds = 0): Map<string, LoadedPolicy> {
  const source = join(defaultPolicyDir(), 'permission.yaml');
  const policy = parsePolicy(readFileSync(source, 'utf8'));
  return new Map([['permission', { policy: { ...policy, cache: { ttlSeconds } }, mode, source }]]);
}

interface Setup {
  readonly decider: Decider;
  readonly engine: FakeEngine;
  readonly log: LogStore;
}

function setup(
  mode: Mode,
  engine = new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
  ttl = 0,
): Setup {
  const log = tempLog();
  const decider = new Decider({
    engine,
    policies: policies(mode, ttl),
    log,
    decisionTimeoutMs: 2000,
  });
  return { decider, engine, log };
}

function deciderOn(mode: Mode, engine: Engine): Decider {
  return new Decider({ engine, policies: policies(mode), log: tempLog(), decisionTimeoutMs: 2000 });
}

const INPUT = {
  project: '/p',
  tool: 'Bash',
  request: { command: 'ls' },
  history: 'user: list files',
};
const req = { harness: 'cli' as const, input: INPUT };
const signal = (): AbortSignal => new AbortController().signal;

interface PrecedentLog extends LogStore {
  readonly records: LogRecord[];
  readonly windows: number[];
  readVerifiedPrecedent(days: number): LogRecord[];
}

function precedentLog(records: LogRecord[] = []): PrecedentLog {
  const windows: number[] = [];
  return {
    records,
    windows,
    append: (record) => records.push(record),
    read: () => records,
    readRecent: (days) => {
      windows.push(days);
      return records;
    },
    readVerifiedPrecedent: (days) => {
      windows.push(days);
      return records;
    },
    prune: () => 0,
    close: () => undefined,
  };
}

function policyAge(loaded: LoadedPolicy, maxAgeDays: number): LoadedPolicy {
  const precedent = loaded.policy.precedent;
  assert.ok(precedent);
  return { ...loaded, policy: { ...loaded.policy, precedent: { ...precedent, maxAgeDays } } };
}

function withoutPrecedent(loaded: LoadedPolicy): LoadedPolicy {
  const policy = { ...loaded.policy };
  delete policy.precedent;
  return { ...loaded, policy };
}

function createPrecedentDecider(
  loadedPolicies: Map<string, LoadedPolicy>,
  log: PrecedentLog,
): Decider {
  return new Decider({
    engine: new FakeEngine({ allow: 0.7, ask: 0.2, deny: 0.1 }),
    policies: loadedPolicies,
    log,
    decisionTimeoutMs: 2000,
  });
}

describe('Decider precedent rebuilds', () => {
  it('reads through the largest precedent age across policies and variants', () => {
    const base = policies('act').get('permission');
    assert.ok(base?.policy.precedent);
    const variant = policyAge(
      {
        ...base,
        policy: { ...base.policy, id: 'permission-variant', variantOf: 'permission' },
      },
      37,
    );
    const log = precedentLog();
    const decider = createPrecedentDecider(
      new Map([
        ['permission', policyAge(base, 14)],
        ['permission-variant', variant],
      ]),
      log,
    );

    decider.rebuildPrecedent();

    assert.deepEqual(log.windows, [37]);
  });

  it('does not read the log when no policy has precedent settings', () => {
    const base = policies('act').get('permission');
    assert.ok(base);
    const log = precedentLog();
    const decider = createPrecedentDecider(new Map([['permission', withoutPrecedent(base)]]), log);

    decider.rebuildPrecedent();

    assert.deepEqual(log.windows, []);
  });

  it('keeps learned evidence on reload when precedent settings are unchanged', async () => {
    const initial = policies('act');
    const loaded = initial.get('permission');
    assert.ok(loaded);
    const log = precedentLog();
    const decider = createPrecedentDecider(initial, log);
    const input = { ...INPUT, subject: 'Bash: npm test' };
    const first = await decider.decide('permission', { harness: 'cli', input }, signal());
    assert.equal(first.action, 'ask');
    decider.noteOutcome({
      kind: 'outcome',
      ts: new Date().toISOString(),
      decisionId: first.decisionId,
      outcome: 'allow',
      source: 'user',
      verified: true,
    });
    log.records.length = 0;

    decider.replacePolicies(
      new Map([
        [
          'permission',
          {
            ...loaded,
            policy: {
              ...loaded.policy,
              version: loaded.policy.version === 1 ? 2 : 1,
            },
          },
        ],
      ]),
    );
    const afterReload = await decider.decide('permission', { harness: 'cli', input }, signal());

    assert.deepEqual(log.windows, []);
    assert.deepEqual(afterReload.precedent, { allows: 1, denies: 0 });
  });

  it('rebuilds on reload when maxAgeDays changes', () => {
    const loaded = policies('act').get('permission');
    assert.ok(loaded);
    const log = precedentLog();
    const decider = createPrecedentDecider(new Map([['permission', policyAge(loaded, 14)]]), log);
    decider.rebuildPrecedent();

    decider.replacePolicies(new Map([['permission', policyAge(loaded, 31)]]));

    assert.deepEqual(log.windows, [14, 31]);
  });
});

describe('Decider', () => {
  it('uses precedent only to lower the allow threshold for an exact subject', async () => {
    const { decider, engine, log } = setup(
      'act',
      new FakeEngine({ allow: 0.7, ask: 0.2, deny: 0.1 }),
    );
    const input = { ...INPUT, subject: 'Bash: npm test' };
    let firstKey: string | undefined;
    for (let index = 0; index < 3; index += 1) {
      const response = await decider.decide('permission', { harness: 'cli', input }, signal());
      assert.equal(response.action, 'ask');
      firstKey ??= response.precedentKey;
      assert.equal(response.precedentKey, firstKey);
      const outcome = {
        kind: 'outcome' as const,
        ts: new Date().toISOString(),
        decisionId: response.decisionId,
        outcome: 'allow',
        source: 'user' as const,
        verified: true,
      };
      log.append(outcome);
      decider.noteOutcome(outcome);
    }
    const loaded = decider.policies.get('permission');
    assert.ok(loaded);
    decider.replacePolicies(
      new Map([
        [
          'permission',
          {
            ...loaded,
            policy: { ...loaded.policy, version: loaded.policy.version === 1 ? 2 : 1 },
          },
        ],
      ]),
    );
    const learned = await decider.decide('permission', { harness: 'cli', input }, signal());
    assert.equal(learned.action, 'allow', JSON.stringify(learned));
    assert.deepEqual(learned.precedent, { allows: 3, denies: 0 });
    assert.equal(learned.precedentKey, firstKey);
    assert.equal(engine.requests.length, 4);
    assert.ok(!JSON.stringify(engine.requests).includes('Bash: npm test'));
    assert.ok(!JSON.stringify(log.read()).includes('Bash: npm test'));
    const otherProject = await decider.decide(
      'permission',
      { harness: 'cli', input: { ...input, project: '/another-project' } },
      signal(),
    );
    assert.equal(otherProject.action, 'ask');
    assert.notEqual(otherProject.precedentKey, firstKey);
  });

  it('enforces only in act mode', async () => {
    const act = await setup('act').decider.decide('permission', req, signal());
    assert.equal(act.action, 'allow');
    assert.equal(act.enforced, true);
    const shadow = await setup('shadow').decider.decide('permission', req, signal());
    assert.equal(shadow.action, 'allow');
    assert.equal(shadow.enforced, false);
  });

  it('off mode abstains without calling the engine', async () => {
    const { decider, engine } = setup('off');
    const res = await decider.decide('permission', req, signal());
    assert.equal(res.action, 'abstain');
    assert.equal(engine.requests.length, 0);
  });

  it('engine failure falls back to the policy default, never enforced', async () => {
    const engine = new FakeEngine();
    engine.respond = () => {
      throw new Error('boom');
    };
    const res = await setup('act', engine).decider.decide('permission', req, signal());
    assert.equal(res.action, 'ask');
    assert.equal(res.enforced, false);
    assert.equal(res.error, 'boom');
  });

  it('skips the engine when it is not ready', async () => {
    const engine = new FakeEngine();
    engine.state = 'starting';
    const res = await setup('act', engine).decider.decide('permission', req, signal());
    assert.equal(res.error, 'engine starting');
    assert.equal(engine.requests.length, 0);
  });

  it('reports a timeout as such', async () => {
    const engine = new FakeEngine();
    engine.respond = async (_r, s) => {
      await sleep(5000, undefined, { signal: s });
      throw new Error('unreachable');
    };
    const log = tempLog();
    const decider = new Decider({ engine, policies: policies('act'), log, decisionTimeoutMs: 50 });
    const res = await decider.decide('permission', req, signal());
    assert.equal(res.error, 'decision timed out');
    assert.equal(res.enforced, false);
  });

  it('rejects unknown policies', async () => {
    await assert.rejects(setup('act').decider.decide('nope', req, signal()), UnknownPolicyError);
  });

  it('sends sorted, redacted, sectioned state with the most relevant section last', async () => {
    const { decider, engine } = setup('shadow');
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    await decider.decide(
      'permission',
      { harness: 'cli', input: { ...INPUT, request: { z: 1, command: `echo ${secret}` } } },
      signal(),
    );
    const state = engine.requests[0]?.state;
    assert.ok(typeof state === 'string');
    assert.ok(!state.includes(secret));
    assert.match(state, /\[REDACTED:github-token\]/);
    assert.ok(state.endsWith('## Request\n{"command":"echo [REDACTED:github-token]","z":1}'));
    assert.ok(state.indexOf('## Project') < state.indexOf('## Recent conversation'));
    assert.deepEqual(Object.keys(engine.requests[0]?.questions ?? {}), ['verdict']);
  });

  it('logs hashes and answers but no state text', async () => {
    const { decider, log } = setup('shadow');
    await decider.decide('permission', req, signal());
    const [record] = log.read();
    assert.equal(record?.kind, 'decision');
    const text = JSON.stringify(record);
    assert.ok(!text.includes('list files'));
    assert.match(text, /"inputHash":"[0-9a-f]{64}"/);
  });

  it('caches identical state within the policy TTL', async () => {
    const { decider, engine } = setup('shadow', undefined, 60);
    const first = await decider.decide('permission', req, signal());
    const second = await decider.decide('permission', req, signal());
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(engine.requests.length, 1);
  });

  it('runs one engine request at a time', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(20);
      return inner(r, s);
    };
    const { decider } = setup('shadow', engine);
    await Promise.all(
      [1, 2, 3].map((i) =>
        decider.decide(
          'permission',
          { harness: 'cli', input: { ...INPUT, tool: String(i) } },
          signal(),
        ),
      ),
    );
    assert.equal(engine.maxInFlight, 1);
    assert.equal(engine.requests.length, 3);
    assert.ok((decider.latency(50) ?? 0) >= 15);
  });

  it('passes /v1/systemone through with keys sorted and secrets redacted', async () => {
    const { decider, engine } = setup('shadow');
    await decider.systemOne(
      {
        state: { b: 'sk-ant-api03-abcdefghijklmnopqrstuv', a: 1 },
        questions: { q: { type: 'choice', instructions: 'x', criteria: { allow: 'a', ask: 'b' } } },
      },
      signal(),
    );
    assert.equal(
      JSON.stringify(engine.requests[0]?.state),
      '{"a":1,"b":"[REDACTED:anthropic-key]"}',
    );
  });
});

describe('Decider under load', () => {
  it('finishes and logs a shadow decision after the caller aborts', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(50);
      return inner(r, s);
    };
    const { decider, log } = setup('shadow', engine);
    const caller = new AbortController();
    const pending = decider.decide('permission', req, caller.signal);
    caller.abort();
    const res = await pending;
    assert.equal(res.error, undefined);
    assert.equal(log.read().length, 1);
  });

  it('aborts an act-mode decision with its caller', async () => {
    const engine = new FakeEngine({ allow: 1 });
    engine.respond = async (_r, s) => {
      await sleep(5000, undefined, { signal: s });
      throw new Error('unreachable');
    };
    const { decider } = setup('act', engine);
    const caller = new AbortController();
    const pending = decider.decide('permission', req, caller.signal);
    caller.abort();
    const res = await pending;
    assert.equal(res.enforced, false);
    assert.equal(res.error, 'decision timed out');
  });

  it('refuses new work once the engine queue is full', async () => {
    const engine = new FakeEngine({ allow: 1 });
    const inner = engine.respond;
    engine.respond = async (r, s) => {
      await sleep(30);
      return inner(r, s);
    };
    const { decider } = setup('act', engine);
    const all = await Promise.all(
      Array.from({ length: QUEUE_MAX + 2 }, (_, i) =>
        decider.decide('permission', toolReq(i), signal()),
      ),
    );
    assert.equal(all.filter((r) => r.error === 'engine queue full').length, 2);
  });

  it('caps shadow decisions at the queue size', async () => {
    const g = Promise.withResolvers<void>();
    const engine = gated(g.promise);
    const { decider, log } = setup('shadow', engine);
    const pending = Array.from({ length: QUEUE_MAX + 2 }, (_, i) =>
      decider.decide('permission', toolReq(i), signal()),
    );
    g.resolve();
    const all = await Promise.all(pending);
    assert.equal(all.filter((r) => r.error === 'engine queue full').length, 2);
    assert.equal(log.read().length, QUEUE_MAX + 2);
  });

  it('a high decision evicts the oldest waiting low one instead of being refused', async () => {
    const g = Promise.withResolvers<void>();
    const engine = gated(g.promise);
    const source = join(defaultPolicyDir(), 'permission.yaml');
    const base = parsePolicy(readFileSync(source, 'utf8'));
    const permission = { ...base, cache: { ttlSeconds: 0 } };
    const background = { ...permission, id: 'background', priority: 'low' as const };
    const loaded = new Map<string, LoadedPolicy>([
      ['permission', { policy: permission, mode: 'act', source }],
      ['background', { policy: background, mode: 'act', source }],
    ]);
    const decider = new Decider({
      engine,
      policies: loaded,
      log: tempLog(),
      decisionTimeoutMs: 2000,
    });
    const lows = Array.from({ length: QUEUE_MAX }, (_, i) =>
      decider.decide('background', toolReq(i), signal()),
    );
    const highs = Array.from({ length: 2 }, (_, i) =>
      decider.decide('permission', toolReq(100 + i), signal()),
    );
    g.resolve();
    const all = await Promise.all([...lows, ...highs]);
    const refused = all.flatMap((r, i) => (r.error === undefined ? [] : [i]));
    assert.deepEqual(refused, [1, 2]);
    assert.equal(all[1]?.error, 'engine queue full');
    assert.equal(engine.requests.length, QUEUE_MAX);
  });

  it('drops a dead act waiter so it holds no queue depth', async () => {
    const g = Promise.withResolvers<void>();
    const engine = gated(g.promise);
    const { decider } = setup('act', engine);
    const a = decider.decide('permission', toolReq(0), signal());
    const controller = new AbortController();
    const b = decider.decide('permission', toolReq(1), controller.signal);
    assert.equal(decider.queueDepth, 2);
    controller.abort();
    assert.equal(decider.queueDepth, 1);
    const res = await b;
    assert.equal(res.error, 'decision timed out');
    assert.equal(res.enforced, false);
    g.resolve();
    await a;
    assert.equal(engine.requests.length, 1);
  });

  it('frees the engine after the deadline when it ignores abort', async () => {
    const warn = mock.method(console, 'error', () => undefined);
    try {
      const engine = new FakeEngine({ allow: 1 });
      const inner = engine.respond;
      let calls = 0;
      engine.respond = (r, s) => {
        calls += 1;
        return calls === 1 ? new Promise(() => undefined) : inner(r, s);
      };
      const log = tempLog();
      const decider = new Decider({
        engine,
        policies: policies('act'),
        log,
        decisionTimeoutMs: 200,
        queueGraceMs: 20,
      });
      const first = await decider.decide('permission', req, signal());
      assert.equal(first.error, 'decision timed out');
      const second = await decider.decide('permission', toolReq(1), signal());
      assert.equal(second.error, undefined);
      assert.equal(warn.mock.callCount(), 1);
      const message = String(warn.mock.calls[0]?.arguments[0]);
      assert.match(message, /past its deadline/);
      assert.ok(!message.includes('list files'));
    } finally {
      warn.mock.restore();
    }
  });

  it('waits for a cold managed engine outside the queue and loads it once', async () => {
    const g = Promise.withResolvers<void>();
    const { managed, inner, starts } = coldEngine(g.promise);
    const decider = deciderOn('act', managed);
    const all = [0, 1, 2].map((i) => decider.decide('permission', toolReq(i), signal()));
    await sleep(10);
    assert.equal(decider.queueDepth, 3);
    assert.equal(starts(), 1);
    g.resolve();
    const done = await Promise.all(all);
    assert.ok(done.every((r) => r.error === undefined));
    assert.equal(starts(), 1);
    assert.equal(inner.maxInFlight, 1);
    assert.equal(inner.requests.length, 3);
    assert.equal(decider.queueDepth, 0);
    await managed.stop();
  });

  it('bounds decisions waiting for a cold engine', async () => {
    const g = Promise.withResolvers<void>();
    const cold = coldEngine(g.promise);
    const decider = deciderOn('shadow', cold.managed);
    const pending = Array.from({ length: QUEUE_MAX + 2 }, (_, i) =>
      decider.decide('permission', toolReq(i), signal()),
    );
    await sleep(10);
    assert.equal(decider.queueDepth, QUEUE_MAX);
    g.resolve();
    const all = await Promise.all(pending);
    assert.equal(all.filter((r) => r.error === 'engine queue full').length, 2);
    assert.equal(all.filter((r) => r.error === undefined).length, QUEUE_MAX);
    await cold.managed.stop();

    const load = Promise.withResolvers<void>();
    const jobs = Promise.withResolvers<void>();
    const hot = coldEngine(load.promise);
    const inner = hot.inner.respond;
    hot.inner.respond = async (r, s) => {
      await jobs.promise;
      return inner(r, s);
    };
    const act = deciderOn('act', hot.managed);
    const highs = Array.from({ length: QUEUE_MAX + 1 }, (_, i) =>
      act.decide('permission', toolReq(i), signal()),
    );
    await sleep(10);
    assert.equal(act.queueDepth, QUEUE_MAX + 1);
    load.resolve();
    await sleep(150);
    jobs.resolve();
    const results = await Promise.all(highs);
    assert.equal(results.filter((r) => r.error === 'engine queue full').length, 1);
    await hot.managed.stop();
  });
});

function toolReq(i: number): typeof req {
  return { harness: 'cli', input: { ...INPUT, tool: String(i) } };
}

function gated(gate: Promise<void>): FakeEngine {
  const engine = new FakeEngine({ allow: 1 });
  const inner = engine.respond;
  engine.respond = async (r, s) => {
    await gate;
    return inner(r, s);
  };
  return engine;
}

function coldEngine(gate: Promise<void>): {
  readonly managed: ManagedEngine;
  readonly inner: FakeEngine;
  readonly starts: () => number;
} {
  const inner = new FakeEngine({ allow: 1 });
  inner.state = 'stopped';
  let count = 0;
  inner.start = async () => {
    count += 1;
    inner.state = 'starting';
    await gate;
    inner.state = 'ready';
  };
  const managed = new ManagedEngine(inner, { lifecycle: 'lazy', idleUnloadMinutes: 15 });
  return { managed, inner, starts: () => count };
}

const REPO_POLICIES = join(import.meta.dirname, '..', '..', '..', 'policies');

function routingSetup(): Setup {
  const loaded = new Map<string, LoadedPolicy>();
  for (const file of ['routing.yaml', 'routing-budget.yaml', 'permission.yaml']) {
    const source = join(REPO_POLICIES, file);
    const policy = parsePolicy(readFileSync(source, 'utf8'), file);
    loaded.set(policy.id, { policy, mode: policy.id === 'routing' ? 'act' : 'off', source });
  }
  const engine = new FakeEngine({ cheap: 0.9, standard: 0.05, premium: 0.05 });
  const log = tempLog();
  return {
    decider: new Decider({ engine, policies: loaded, log, decisionTimeoutMs: 2000 }),
    engine,
    log,
  };
}

const routingReq = { harness: 'cli' as const, input: { project: '/p', prompt: 'rename foo' } };

describe('Decider variants', () => {
  it('lists a policy and its variants, and nothing for unknown or variant ids', () => {
    const { decider } = routingSetup();
    assert.deepEqual(decider.variantsOf('routing'), ['routing', 'routing-budget']);
    assert.deepEqual(decider.variantsOf('routing-budget'), []);
    assert.deepEqual(decider.variantsOf('nope'), []);
    assert.equal(decider.activeVariant('routing'), 'routing');
  });

  it('answers with the selected variant under the requested policy and its mode', async () => {
    const { decider, engine, log } = routingSetup();
    assert.equal(decider.setVariant('routing', 'routing-budget'), true);
    const res = await decider.decide('routing', routingReq, signal());
    assert.equal(res.policy, 'routing');
    assert.equal(res.variant, 'routing-budget');
    assert.equal(res.action, 'route:cheap');
    assert.equal(res.enforced, true, 'the mode of routing (act), not of routing-budget (off)');
    assert.deepEqual(Object.keys(engine.requests[0]?.questions ?? {}), ['tier']);
    const [record] = log.read();
    assert.equal(record?.kind === 'decision' ? record.variant : undefined, 'routing-budget');
  });

  it('refuses policies that are not variants, and restores the default', () => {
    const { decider } = routingSetup();
    assert.equal(decider.setVariant('routing', 'permission'), false);
    assert.equal(decider.setVariant('routing-budget', 'routing'), false);
    assert.equal(decider.setVariant('routing', 'routing-budget'), true);
    assert.equal(decider.setVariant('routing', 'routing'), true);
    assert.equal(decider.activeVariant('routing'), 'routing');
  });

  it('applies threshold overrides of the policy whose rules answer', async () => {
    const { decider } = setup('act', new FakeEngine({ allow: 0.9, ask: 0.05, deny: 0.05 }));
    assert.equal((await decider.decide('permission', req, signal())).action, 'ask');
    assert.equal(decider.setThresholds('permission', { 'verdict.allow': 0.85, 'x.y': 1 }), true);
    assert.equal((await decider.decide('permission', req, signal())).action, 'allow');
    assert.deepEqual(
      decider.thresholdsOf('permission').map((t) => [t.key, t.kind, t.default, t.value]),
      [
        ['verdict.allow', 'minProbability', 0.95, 0.85],
        ['verdict.deny', 'minConfidence', 0.8, 0.8],
      ],
    );
    assert.equal(decider.setThresholds('nope', {}), false);
    decider.setThresholds('permission', {});
    assert.equal(decider.thresholdsOf('permission')[0]?.value, 0.95);
  });

  it('keeps threshold overrides that still name a rule across reloads', () => {
    const { decider } = routingSetup();
    decider.setThresholds('routing-budget', { 'tier.cheap': 0.2 });
    decider.replacePolicies(new Map(decider.policies));
    assert.equal(decider.thresholdsOf('routing-budget')[1]?.value, 0.2);
    decider.replacePolicies(
      new Map([...decider.policies].filter(([id]) => id !== 'routing-budget')),
    );
    assert.deepEqual(decider.thresholdsOf('routing-budget'), []);
  });

  it('drops a variant choice whose policy disappears on reload', () => {
    const { decider } = routingSetup();
    decider.setVariant('routing', 'routing-budget');
    decider.replacePolicies(
      new Map([...decider.policies].filter(([id]) => id !== 'routing-budget')),
    );
    assert.equal(decider.activeVariant('routing'), 'routing');
  });
});

describe('renderValue', () => {
  it('passes strings, sorts objects, blanks nullish', () => {
    assert.equal(renderValue('x'), 'x');
    assert.equal(renderValue({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(renderValue(null), '');
    assert.equal(renderValue(undefined), '');
  });
});
