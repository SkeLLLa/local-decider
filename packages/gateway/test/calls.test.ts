import type { ShadowRecord } from '@local-decider/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { startGateway, type Gateway } from '../src/runtime.ts';
import { ShadowLog } from '../src/shadow.ts';
import { FakeEngine, tempPaths, testConfig } from './helpers.ts';

type Body = Record<string, unknown>;

async function post(gw: Gateway, path: string, body: Body): Promise<Body> {
  const res = await fetch(`${gw.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Body;
}

const input = { project: '/project', subject: 'Bash: npm test', request: 'npm test' };

function decisions(logs: string): ShadowRecord[] {
  return new ShadowLog(logs).read().filter((r): r is ShadowRecord => r.kind === 'decision');
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
      const [record] = decisions(paths.logs);
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
      const [first, second] = decisions(paths.logs);
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
      await post(gw, '/v1/outcomes', { decisionId: 'd1', outcome: 'allow', source: 'classifier' });
      const outcome = new ShadowLog(paths.logs).read().find((r) => r.kind === 'outcome');
      assert.equal(outcome?.kind === 'outcome' ? outcome.source : '', 'classifier');
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
    return { response, record: decisions(paths.logs)[0] };
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
