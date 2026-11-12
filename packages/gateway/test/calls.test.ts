import type { ShadowRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { Paths } from '../src/paths.ts';
import { startGateway, type Gateway } from '../src/runtime.ts';
import { FakeEngine, readLog, tempPaths, testConfig } from './helpers.ts';

type Body = Record<string, unknown>;

async function post(
  gw: Gateway,
  path: string,
  body: Body,
  headers: Record<string, string> = {},
): Promise<Body> {
  const res = await fetch(`${gw.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Body;
}

const input = { project: '/project', subject: 'Bash: npm test', request: 'npm test' };

function decisions(paths: Paths): ShadowRecord[] {
  return readLog(paths).filter((r): r is ShadowRecord => r.kind === 'decision');
}

describe('decide call and scope fields', () => {
  it('logs a valid call and scope on the decision record', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig({ policies: { permission: { mode: 'act' } } }),
      paths,
      engine: new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
      env: {},
    });
    try {
      await post(gw, '/v1/decide/permission', {
        harness: 'claude-code',
        input,
        scope: 'claude-auto',
        call: { id: 'toolu_01-A_b', permissionMode: 'auto', agent: true },
      });
      const [record] = decisions(paths);
      assert.equal(record?.scope, 'claude-auto');
      assert.equal(record?.callId, 'toolu_01-A_b');
      assert.equal(record?.permissionMode, 'auto');
      assert.equal(record?.subagent, true);
    } finally {
      await gw.close();
    }
  });

  it('drops an invalid call id, permission mode and scope instead of failing', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig({ policies: { permission: { mode: 'act' } } }),
      paths,
      engine: new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
      env: {},
    });
    try {
      const badId = await post(gw, '/v1/decide/permission', {
        harness: 'claude-code',
        input,
        scope: 'nope',
        call: { id: '../etc/passwd', permissionMode: 'auto' },
      });
      assert.equal(badId['action'], 'allow');
      const badMode = await post(gw, '/v1/decide/permission', {
        harness: 'claude-code',
        input,
        call: { id: 'toolu_2', permissionMode: 'root' },
      });
      assert.equal(badMode['action'], 'allow');
      const [first, second] = decisions(paths);
      assert.equal(first?.callId, undefined);
      assert.equal(first?.scope, undefined);
      assert.equal(second?.callId, 'toolu_2');
      assert.equal(second?.permissionMode, undefined);
    } finally {
      await gw.close();
    }
  });

  it('accepts classifier as an outcome source', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig(),
      paths,
      engine: new FakeEngine({ allow: 1 }),
      env: {},
    });
    try {
      await post(
        gw,
        '/v1/outcomes',
        { decisionId: 'd1', outcome: 'allow', source: 'classifier' },
        { 'x-local-decider-report': readFileSync(join(paths.config, 'report-token'), 'utf8') },
      );
      const outcome = readLog(paths).find((r) => r.kind === 'outcome');
      assert.equal(outcome?.kind === 'outcome' ? outcome.source : '', 'classifier');
      assert.equal(outcome?.kind === 'outcome' ? outcome.verified : false, true);
    } finally {
      await gw.close();
    }
  });
});

async function run(
  policies: Record<string, unknown>,
  scope?: string,
): Promise<{ response: Body; record: ShadowRecord | undefined }> {
  const paths = tempPaths();
  const gw = await startGateway({
    config: testConfig({ policies }),
    paths,
    engine: new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
    env: {},
  });
  try {
    const response = await post(gw, '/v1/decide/permission', {
      harness: 'claude-code',
      input,
      ...(scope === undefined ? {} : { scope }),
    });
    return { response, record: decisions(paths)[0] };
  } finally {
    await gw.close();
  }
}

describe('scope modes', () => {
  it('caps a scoped request at shadow when the scope mode is unset', async () => {
    const { response, record } = await run({ permission: { mode: 'act' } }, 'claude-auto');
    assert.equal(response['mode'], 'shadow');
    assert.equal(response['enforced'], false);
    assert.equal(response['scope'], 'claude-auto');
    assert.equal(response['action'], 'allow');
    assert.equal(record?.mode, 'shadow');
    assert.equal(record?.scope, 'claude-auto');
  });

  it('enforces a scoped request when policy and scope are both act', async () => {
    const { response } = await run(
      { permission: { mode: 'act', scopes: { 'claude-auto': { mode: 'act' } } } },
      'claude-auto',
    );
    assert.equal(response['mode'], 'act');
    assert.equal(response['enforced'], true);
  });

  it('never runs above the policy mode', async () => {
    const shadow = await run(
      { permission: { mode: 'shadow', scopes: { 'claude-auto': { mode: 'act' } } } },
      'claude-auto',
    );
    assert.equal(shadow.response['mode'], 'shadow');
    const off = await run(
      { permission: { mode: 'off', scopes: { 'claude-auto': { mode: 'act' } } } },
      'claude-auto',
    );
    assert.equal(off.response['mode'], 'off');
    assert.equal(off.response['action'], 'abstain');
  });

  it('lets a scope turn itself off below the policy mode', async () => {
    const { response } = await run(
      { permission: { mode: 'act', scopes: { 'claude-auto': { mode: 'off' } } } },
      'claude-auto',
    );
    assert.equal(response['mode'], 'off');
  });

  it('leaves unscoped requests at the policy mode', async () => {
    const { response } = await run({
      permission: { mode: 'act', scopes: { 'claude-auto': { mode: 'off' } } },
    });
    assert.equal(response['mode'], 'act');
    assert.equal(response['enforced'], true);
    assert.equal(response['scope'], undefined);
  });
});

async function start(
  engine: FakeEngine,
  policies: Record<string, unknown>,
): Promise<{ gw: Gateway; paths: ReturnType<typeof tempPaths> }> {
  const paths = tempPaths();
  const gw = await startGateway({ config: testConfig({ policies }), paths, engine, env: {} });
  return { gw, paths };
}

const getCall = (gw: Gateway, id: string): Promise<Response> => fetch(`${gw.url}/v1/calls/${id}`);

describe('GET /v1/calls/:id', () => {
  it('returns the decisions and scope modes recorded for a call', async () => {
    const { gw } = await start(new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }), {
      permission: { mode: 'act', scopes: { 'claude-auto': { mode: 'act' } } },
    });
    try {
      const decided = await post(gw, '/v1/decide/permission', {
        harness: 'claude-code',
        input,
        call: { id: 'toolu_1', permissionMode: 'auto' },
      });
      const res = await getCall(gw, 'toolu_1');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        permissionMode: 'auto',
        decisions: {
          permission: {
            decisionId: decided['decisionId'],
            action: 'allow',
            enforced: true,
            answered: true,
          },
        },
        scopes: { 'claude-auto': 'act' },
      });
    } finally {
      await gw.close();
    }
  });

  it('reports shadow for an unconfigured scope and 404 for unknown or malformed ids', async () => {
    const { gw } = await start(new FakeEngine({ allow: 1 }), { permission: { mode: 'act' } });
    try {
      await post(gw, '/v1/decide/permission', {
        harness: 'claude-code',
        input,
        call: { id: 'toolu_2' },
      });
      const body = (await (await getCall(gw, 'toolu_2')).json()) as Body;
      assert.deepEqual(body['scopes'], { 'claude-auto': 'shadow' });
      assert.equal((await getCall(gw, 'nope')).status, 404);
      assert.equal((await getCall(gw, 'a%20b')).status, 404);
      assert.equal((await getCall(gw, 'x'.repeat(129))).status, 404);
    } finally {
      await gw.close();
    }
  });

  it('records a shadow decision that finishes after its caller timed out', async () => {
    const engine = new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 });
    const inner = engine.respond;
    engine.respond = async (request, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return inner(request, signal);
    };
    const { gw } = await start(engine, { permission: { mode: 'shadow' } });
    try {
      await assert.rejects(
        fetch(`${gw.url}/v1/decide/permission`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            harness: 'claude-code',
            input,
            call: { id: 'toolu_slow', permissionMode: 'auto' },
          }),
          signal: AbortSignal.timeout(50),
        }),
      );
      assert.equal((await getCall(gw, 'toolu_slow')).status, 404, 'not decided yet');
      let status = 404;
      for (let attempt = 0; attempt < 40 && status === 404; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = (await getCall(gw, 'toolu_slow')).status;
      }
      assert.equal(status, 200);
      const body = (await (await getCall(gw, 'toolu_slow')).json()) as {
        decisions: Record<string, { answered: boolean; action: string }>;
      };
      assert.equal(body.decisions['permission']?.answered, true);
      assert.equal(body.decisions['permission']?.action, 'allow');
    } finally {
      await gw.close();
    }
  });
});

describe('GET /v1/stats?scope=', () => {
  it('serves the classifier agreement section for a scope filter', async () => {
    const paths = tempPaths();
    const gw = await startGateway({
      config: testConfig({ policies: { permission: { mode: 'shadow' } } }),
      paths,
      engine: new FakeEngine({ allow: 0.97, ask: 0.02, deny: 0.01 }),
      env: {},
    });
    try {
      const scoped = await post(gw, '/v1/decide/permission', {
        harness: 'claude-code',
        input,
        scope: 'claude-auto',
        call: { id: 'toolu_s' },
      });
      await post(gw, '/v1/decide/permission', {
        harness: 'claude-code',
        input: { ...input, request: 'ls' },
      });
      await post(
        gw,
        '/v1/outcomes',
        {
          decisionId: scoped['decisionId'],
          outcome: 'allow',
          source: 'classifier',
        },
        { 'x-local-decider-report': readFileSync(join(paths.config, 'report-token'), 'utf8') },
      );
      const all = (await (await fetch(`${gw.url}/v1/stats`)).json()) as Body[];
      assert.equal(all[0]?.['decisions'], 2);
      const filtered = (await (await fetch(`${gw.url}/v1/stats?scope=claude-auto`)).json()) as {
        decisions: number;
        classifierAgreement: { n: number; allowPrecision: number };
      }[];
      assert.equal(filtered[0]?.decisions, 1);
      assert.equal(filtered[0]?.classifierAgreement.n, 1);
      assert.equal(filtered[0]?.classifierAgreement.allowPrecision, 1);
    } finally {
      await gw.close();
    }
  });
});
