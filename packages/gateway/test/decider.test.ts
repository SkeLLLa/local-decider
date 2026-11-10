import { parsePolicy, type Mode } from '@local-decider/core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Decider, QUEUE_MAX, renderValue, UnknownPolicyError } from '../src/decider.ts';
import { defaultPolicyDir, type LoadedPolicy } from '../src/policies.ts';
import { ShadowLog } from '../src/shadow.ts';
import { FakeEngine, tempPaths } from './helpers.ts';

function policies(mode: Mode, ttlSeconds = 0): Map<string, LoadedPolicy> {
  const source = join(defaultPolicyDir(), 'permission.yaml');
  const policy = parsePolicy(readFileSync(source, 'utf8'));
  return new Map([['permission', { policy: { ...policy, cache: { ttlSeconds } }, mode, source }]]);
}

interface Setup {
  readonly decider: Decider;
  readonly engine: FakeEngine;
  readonly log: ShadowLog;
}

function setup(
  mode: Mode,
  engine = new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
  ttl = 0,
): Setup {
  const log = new ShadowLog(tempPaths().logs);
  const decider = new Decider({
    engine,
    policies: policies(mode, ttl),
    log,
    decisionTimeoutMs: 2000,
  });
  return { decider, engine, log };
}

const INPUT = {
  project: '/p',
  tool: 'Bash',
  request: { command: 'ls' },
  history: 'user: list files',
};
const req = { harness: 'cli' as const, input: INPUT };
const signal = (): AbortSignal => new AbortController().signal;

describe('Decider', () => {
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
    const log = new ShadowLog(tempPaths().logs);
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
    const { decider } = setup('shadow', engine);
    const all = await Promise.all(
      Array.from({ length: QUEUE_MAX + 2 }, (_, i) =>
        decider.decide(
          'permission',
          { harness: 'cli', input: { ...INPUT, tool: String(i) } },
          signal(),
        ),
      ),
    );
    assert.equal(all.filter((r) => r.error === 'engine queue full').length, 2);
  });
});

const REPO_POLICIES = join(import.meta.dirname, '..', '..', '..', 'policies');

function routingSetup(): Setup {
  const loaded = new Map<string, LoadedPolicy>();
  for (const file of ['routing.yaml', 'routing-budget.yaml', 'permission.yaml']) {
    const source = join(REPO_POLICIES, file);
    const policy = parsePolicy(readFileSync(source, 'utf8'), file);
    loaded.set(policy.id, { policy, mode: policy.id === 'routing' ? 'act' : 'off', source });
  }
  const engine = new FakeEngine({ cheap: 0.9, standard: 0.05, premium: 0.05 });
  const log = new ShadowLog(tempPaths().logs);
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
