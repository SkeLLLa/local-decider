import type {
  PluginHookAgent,
  PluginSessionOpenRequest,
  PluginTurnOutcome,
} from '@getpaseo/plugin/server';
import type { AgentPermissionRequest, AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Background } from '../server/background.ts';
import type { HookDeps } from '../server/deps.ts';
import { LabelRegistry } from '../server/labels.ts';
import { mcpServerConfig } from '../server/mcp.ts';
import { createOpenHandler, hostEnv } from '../server/open.ts';
import { allowResponse, createPermissionHandlers } from '../server/permission.ts';
import { createRoutingHandler, type CreateRequest } from '../server/routing.ts';
import { createStatusHandler, manualDecide } from '../server/rpc.ts';
import { createTurnHandler, pluginEnforces } from '../server/turn.ts';
import { ctx, deps, fakeGateway, fakePaseo, response, settings } from './fakes.ts';

type Paseo = ReturnType<typeof fakePaseo>;

const agent: PluginHookAgent = {
  id: 'a1',
  workspaceId: 'w1',
  parentAgentId: null,
  provider: 'claude',
  cwd: '/p',
  title: null,
};

const turn: { item: AgentTimelineItem; turnId?: string }[] = [
  { item: { type: 'user_message', text: 'Add tests' }, turnId: 't1' },
  { item: { type: 'assistant_message', text: 'Should I use vitest or node:test?' }, turnId: 't1' },
];

const toolItem = (name: string): AgentTimelineItem => ({
  type: 'tool_call',
  callId: name,
  name,
  status: 'completed',
  error: null,
  detail: { type: 'unknown', input: null, output: null },
});

const completed = { kind: 'completed' } as const;

/** A boolean field of an appended row's data. */
function flag(item: { data: unknown } | undefined, key: string): unknown {
  assert.ok(item !== undefined, 'a row was appended');
  return (item.data as Record<string, unknown>)[key];
}

describe('pluginEnforces', () => {
  it('needs gateway enforcement, plugin act and no engine error', () => {
    assert.equal(pluginEnforces(response({ enforced: true }), 'act'), true);
    assert.equal(pluginEnforces(response({ enforced: true }), 'shadow'), false);
    assert.equal(pluginEnforces(response({ enforced: false }), 'act'), false);
    assert.equal(pluginEnforces(response({ enforced: true, error: 'x' }), 'act'), false);
  });
});

describe('agent.turn.after', () => {
  const bg = new Background();
  const turnHandler = (
    d: HookDeps,
  ): ((paseo: Paseo, outcome?: PluginTurnOutcome) => Promise<void>) => {
    const handler = createTurnHandler(d, { background: bg });
    return async (paseo, outcome = completed) => {
      await handler({ agent, turnId: 't1', outcome }, ctx(paseo));
      await bg.idle();
    };
  };

  it('returns before the decision and appends one row per turn when it lands', async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const gw = fakeGateway(async () => {
      await gate;
      return response({ action: 'notify', mode: 'act', enforced: true });
    });
    const s = settings({
      modes: { 'turn-outcome': 'act', 'permission': 'shadow', 'routing': 'shadow' },
    });
    const paseo = fakePaseo(turn);
    const handler = createTurnHandler(deps(s, gw), { background: bg });
    await handler({ agent, turnId: 't1', outcome: completed }, ctx(paseo));
    assert.equal(paseo.agent.appended.length, 0, 'hook returned before the decision');
    release();
    await bg.idle();
    await handler({ agent, turnId: 't1', outcome: completed }, ctx(paseo));
    await bg.idle();

    assert.equal(gw.calls.length, 1, 'deduped per turn');
    assert.equal(gw.calls[0]?.policy, 'turn-outcome');
    assert.equal(gw.calls[0]?.sessionId, 'a1');
    assert.deepEqual(Object.keys(gw.calls[0]?.input ?? {}), ['task', 'history', 'lastMessage']);
    assert.equal(paseo.agent.appended.length, 1);
    const row = paseo.agent.appended[0];
    assert.equal(row?.id, 'local-decider-turn-t1');
    assert.equal(row?.kind, 'decision');
    assert.equal(flag(row, 'attention'), true);
  });

  it('records but never flags attention in shadow mode', async () => {
    const gw = fakeGateway(() => response({ action: 'notify', mode: 'act', enforced: true }));
    const paseo = fakePaseo(turn);
    await turnHandler(deps(settings(), gw))(paseo);
    assert.equal(flag(paseo.agent.appended[0], 'attention'), false);
  });

  it('does nothing when off, canceled, or the gateway is down', async () => {
    const off = settings({
      modes: { 'turn-outcome': 'off', 'permission': 'shadow', 'routing': 'shadow' },
    });
    const gw = fakeGateway(() => response());
    const paseo = fakePaseo(turn);
    await turnHandler(deps(off, gw))(paseo);
    await turnHandler(deps(settings(), gw))(paseo, { kind: 'canceled', reason: 'user' });
    await turnHandler(
      deps(
        settings(),
        fakeGateway(() => null),
      ),
    )(paseo);
    assert.equal(gw.calls.length, 0);
    assert.equal(paseo.agent.appended.length, 0);
  });

  it('swallows timeline failures', async () => {
    const d = deps(
      settings(),
      fakeGateway(() => response()),
    );
    const paseo = fakePaseo(turn);
    paseo.agent.timeline.refetch = async () => {
      throw new Error('agent gone');
    };
    await turnHandler(d)(paseo);
    assert.match(d.logs[0] ?? '', /agent gone/);
  });
});

const toolRequest: AgentPermissionRequest = {
  id: 'r1',
  provider: 'claude',
  name: 'Read',
  kind: 'tool',
  input: { path: 'README.md' },
};

const actMode = settings({
  modes: { 'turn-outcome': 'shadow', 'permission': 'act', 'routing': 'shadow' },
});

describe('agent.permission.before', () => {
  const bg = new Background();
  const permissionHandlers = (
    d: HookDeps,
  ): ReturnType<typeof createPermissionHandlers> & {
    request: (paseo: Paseo, request?: AgentPermissionRequest) => Promise<void>;
  } => {
    const handlers = createPermissionHandlers(d, bg);
    return {
      ...handlers,
      request: async (paseo, request = toolRequest) => {
        await handlers.before({ agent, request }, ctx(paseo));
        await bg.idle();
      },
    };
  };

  const labelled = (
    d: HookDeps,
    labels: LabelRegistry,
  ): ReturnType<typeof createPermissionHandlers> & { request: (paseo: Paseo) => Promise<void> } => {
    const handlers = createPermissionHandlers(d, bg, { labels, now: () => 1_000 });
    return {
      ...handlers,
      request: async (paseo: Paseo) => {
        await handlers.before({ agent, request: toolRequest }, ctx(paseo));
        await bg.idle();
      },
    };
  };

  it('auto-allows only an enforced allow with the plugin in act', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo(turn);
    const handlers = permissionHandlers(deps(actMode, gw));
    await handlers.request(paseo);
    assert.deepEqual(paseo.agent.responses, [{ requestId: 'r1', response: { behavior: 'allow' } }]);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), true);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    assert.equal(gw.outcomes.length, 0, 'own auto-allow is not ground truth');
  });

  it('never denies and leaves the request pending otherwise', async () => {
    for (const [s, res] of [
      [actMode, response({ action: 'deny', mode: 'act', enforced: true })],
      [actMode, response({ action: 'allow', mode: 'shadow', enforced: false })],
      [settings(), response({ action: 'allow', mode: 'act', enforced: true })],
    ] as const) {
      const paseo = fakePaseo(turn);
      await permissionHandlers(
        deps(
          s,
          fakeGateway(() => res),
        ),
      ).request(paseo);
      assert.deepEqual(paseo.agent.responses, []);
      assert.equal(paseo.agent.appended.length, 1, 'still recorded');
    }
  });

  it('keeps task context after it falls outside the 100 item window', async () => {
    let items: { item: AgentTimelineItem }[] = [
      { item: { type: 'user_message', text: 'Build parser' } },
    ];
    const limits: number[] = [];
    const paseo = fakePaseo(items);
    paseo.agent.timeline.refetch = async (options) => {
      limits.push(options.limit);
      return { entries: items.slice(-options.limit) };
    };
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const handlers = permissionHandlers(deps(settings(), gw));

    await handlers.request(paseo);
    items = [
      ...Array.from({ length: 120 }, (_, index) => ({ item: toolItem(`Tool${index}`) })),
      { item: { type: 'user_message', text: 'Narrow the change' } },
    ];
    await handlers.request(paseo, { ...toolRequest, id: 'r2' });

    assert.deepEqual(limits, [100, 100]);
    assert.equal(
      gw.calls[1]?.input['task'],
      'First request: Build parser\nLatest request: Narrow the change',
    );
    assert.equal(String(gw.calls[1]?.input['history']).split('\n').length, 20);
  });

  it('swallows the already-resolved race', async () => {
    const gw = fakeGateway(() => response({ action: 'allow', mode: 'act', enforced: true }));
    const paseo = fakePaseo(turn, async () => {
      throw new Error('Permission request r1 is not pending');
    });
    const d = deps(actMode, gw);
    await permissionHandlers(d).request(paseo);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
    assert.deepEqual(d.logs, []);
  });

  it('skips questions and plan approvals, and reports user answers as outcomes', async () => {
    const gw = fakeGateway(() => response({ action: 'ask' }));
    const paseo = fakePaseo(turn);
    const handlers = permissionHandlers(deps(settings(), gw));
    await handlers.request(paseo, { ...toolRequest, id: 'q', kind: 'question' });
    assert.equal(gw.calls.length, 0);
    await handlers.request(paseo);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'decline', source: 'user' }]);
  });

  it('reports one user outcome and redraws the row with it', async () => {
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const paseo = fakePaseo(turn);
    const handlers = permissionHandlers(deps(settings(), gw));
    await handlers.request(paseo);
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'allow', source: 'user' }]);
    assert.equal(paseo.agent.appended.length, 2);
    assert.equal(paseo.agent.appended[1]?.id, paseo.agent.appended[0]?.id, 'same row id');
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), null);
    assert.equal(flag(paseo.agent.appended[1], 'feedback'), 'allow');
  });

  it('reports parent answers as supervised outcomes', async () => {
    const child = { ...agent, id: 'child', parentAgentId: 'parent' };
    const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
    const paseo = fakePaseo(turn);
    const handlers = createPermissionHandlers(deps(settings(), gw), bg);
    await handlers.before({ agent: child, request: toolRequest }, ctx(paseo));
    await bg.idle();
    await handlers.after({ agent: child, requestId: 'r1', resolution: { behavior: 'deny' } });

    assert.deepEqual(gw.outcomes, [
      { decisionId: 'd-1', outcome: 'decline', source: 'supervised' },
    ]);
  });

  it('keeps a user answer that arrives before the decision lands', async () => {
    const gate = Promise.withResolvers<void>();
    const gw = fakeGateway(async () => {
      await gate.promise;
      return response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true });
    });
    const paseo = fakePaseo(turn);
    const handlers = createPermissionHandlers(deps(actMode, gw), bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    // Let the detached task reach `decide`.
    await new Promise((resolve) => setImmediate(resolve));
    await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
    gate.resolve();
    await bg.idle();
    assert.deepEqual(paseo.agent.responses, [], 'no allow after the user answered');
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'decline', source: 'user' }]);
    assert.equal(paseo.agent.appended.length, 1);
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), 'decline');
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
  });

  it('does not report its own auto-allow when after fires mid-response', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    let handlers: ReturnType<typeof createPermissionHandlers> | null = null;
    const paseo = fakePaseo(turn, async () => {
      await handlers?.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
    });
    handlers = createPermissionHandlers(deps(actMode, gw), bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    await bg.idle();
    assert.deepEqual(gw.outcomes, []);
    assert.equal(paseo.agent.appended.length, 1);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), true);
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), null);
  });

  it('reports the user when their answer beat our allow', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
    );
    let handlers: ReturnType<typeof createPermissionHandlers> | null = null;
    const paseo = fakePaseo(turn, async () => {
      await handlers?.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      throw new Error('Permission request r1 is not pending');
    });
    handlers = createPermissionHandlers(deps(actMode, gw), bg);
    await handlers.before({ agent, request: toolRequest }, ctx(paseo));
    await bg.idle();
    assert.deepEqual(gw.outcomes, [{ decisionId: 'd-1', outcome: 'decline', source: 'user' }]);
    assert.equal(flag(paseo.agent.appended[0], 'applied'), false);
    assert.equal(flag(paseo.agent.appended[0], 'feedback'), 'decline');
  });

  describe('outcome labels', () => {
    const rowId = 'local-decider-permission-r1';

    it('maps an interrupting deny to interrupted and a plain deny to decline', async () => {
      const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
      const paseo = fakePaseo(turn);
      const handlers = labelled(deps(settings(), gw), new LabelRegistry());
      await handlers.request(paseo);
      await handlers.after({
        agent,
        requestId: 'r1',
        resolution: { behavior: 'deny', interrupt: true },
      });
      assert.equal(gw.outcomes[0]?.outcome, 'interrupted');
      assert.equal(flag(paseo.agent.appended[1], 'feedback'), 'interrupted');
      await handlers.request(paseo);
      await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      assert.equal(gw.outcomes[1]?.outcome, 'decline');
    });

    it('stamps answeredAt and registers a declined row', async () => {
      const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
      const paseo = fakePaseo(turn);
      const labels = new LabelRegistry();
      const handlers = labelled(deps(settings(), gw), labels);
      await handlers.request(paseo);
      assert.equal(labels.get(agent.id, rowId), undefined, 'unanswered rows are not labelable');
      await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      assert.equal(flag(paseo.agent.appended[1], 'answeredAt'), 1_000);
      const entry = labels.get(agent.id, rowId);
      assert.equal(entry?.kind, 'declined');
      assert.equal(entry?.decisionId, 'd-1');
      assert.equal(entry?.answeredAt, 1_000);
    });

    it('registers a keyed auto-allow and not an unkeyed one', async () => {
      const keyed = fakeGateway(() =>
        response({
          policy: 'permission',
          action: 'allow',
          mode: 'act',
          enforced: true,
          precedentKey: 'k',
        }),
      );
      const labels = new LabelRegistry();
      const paseo = fakePaseo(turn);
      await labelled(deps(actMode, keyed), labels).request(paseo);
      assert.equal(flag(paseo.agent.appended[0], 'answeredAt'), 1_000);
      assert.equal(flag(paseo.agent.appended[0], 'vetoable'), true);
      assert.equal(labels.get(agent.id, rowId)?.kind, 'auto-allowed');

      const unkeyed = fakeGateway(() =>
        response({ policy: 'permission', action: 'allow', mode: 'act', enforced: true }),
      );
      const other = new LabelRegistry();
      await labelled(deps(actMode, unkeyed), other).request(fakePaseo(turn));
      assert.equal(other.get(agent.id, rowId), undefined);
    });

    it('does not register hidden rows or the user allow', async () => {
      const gw = fakeGateway(() => response({ policy: 'permission', action: 'ask' }));
      const hidden = new LabelRegistry();
      const hiddenHandlers = labelled(
        deps(settings({ rows: { show: 'off', details: true, feedback: true } }), gw),
        hidden,
      );
      await hiddenHandlers.request(fakePaseo(turn));
      await hiddenHandlers.after({ agent, requestId: 'r1', resolution: { behavior: 'deny' } });
      assert.equal(hidden.get(agent.id, rowId), undefined);

      const allowed = new LabelRegistry();
      const handlers = labelled(deps(settings(), gw), allowed);
      await handlers.request(fakePaseo(turn));
      await handlers.after({ agent, requestId: 'r1', resolution: { behavior: 'allow' } });
      assert.equal(allowed.get(agent.id, rowId), undefined);
    });
  });

  it('selects the primary allow action when the request offers actions', () => {
    assert.deepEqual(
      allowResponse({
        ...toolRequest,
        actions: [
          { id: 'no', label: 'No', behavior: 'deny' },
          { id: 'once', label: 'Once', behavior: 'allow' },
          { id: 'always', label: 'Always', behavior: 'allow', variant: 'primary' },
        ],
      }),
      { behavior: 'allow', selectedActionId: 'always' },
    );
  });
});

const createRequest = (title: string | null): { request: CreateRequest } => ({
  request: { config: { provider: 'claude', cwd: '/p', model: 'opus', title } },
});

const routingAct = settings({
  modes: { 'turn-outcome': 'shadow', 'permission': 'shadow', 'routing': 'act' },
  presets: {
    fast: { model: 'claude/haiku', modeId: '' },
    standard: { model: '', modeId: '' },
    deep: { model: 'codex/gpt-5.5', modeId: '' },
  },
});

const autoProfileRoute = (): ReturnType<typeof response> =>
  response({
    policy: 'routing',
    action: 'route:fast',
    mode: 'act',
    enforced: true,
    route: { preset: 'fast', profile: 'implementer' },
  });
const paseoWithProfile = {
  config: {
    get: async () => ({
      config: {
        agentProfiles: [{ id: 'implementer', provider: 'claude', model: 'haiku', modeId: 'auto' }],
      },
    }),
  },
};
const withMode = (modeId: string | undefined, provider = 'claude'): { request: CreateRequest } => ({
  request: {
    config: {
      provider,
      cwd: '/p',
      model: 'opus',
      title: 'Rename',
      ...(modeId === undefined ? {} : { modeId }),
    },
  },
});

describe('agent.create.before', () => {
  const signal = new AbortController().signal;

  it('applies an enforced, mapped preset', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'routing', action: 'route:fast', mode: 'act', enforced: true }),
    );
    const out = await createRoutingHandler(deps(routingAct, gw))(createRequest('Rename foo'), {
      signal,
    });
    assert.equal(out?.config.model, 'haiku');
    assert.deepEqual(gw.calls[0]?.input, { project: '/p', prompt: 'Rename foo' });
  });

  it('applies the route the gateway resolved from config.yaml over plugin settings', async () => {
    const gw = fakeGateway(() =>
      response({
        policy: 'routing',
        action: 'route:fast',
        mode: 'act',
        enforced: true,
        route: { preset: 'fast', model: 'codex/gpt-mini', mode: 'auto' },
      }),
    );
    const out = await createRoutingHandler(deps(routingAct, gw))(createRequest('Rename'), {
      signal,
    });
    assert.equal(out?.config.provider, 'codex');
    assert.equal(out?.config.model, 'gpt-mini');
    assert.equal(out?.config.modeId, 'auto');
  });

  describe('caller mode', () => {
    it('keeps the mode the caller pinned', async () => {
      const gw = fakeGateway(autoProfileRoute);
      const out = await createRoutingHandler(deps(routingAct, gw))(withMode('default'), {
        signal,
        paseo: paseoWithProfile,
      });
      assert.equal(out?.config.model, 'haiku');
      assert.equal(out?.config.modeId, 'default');
    });

    it('applies the profile mode when the caller left it unset', async () => {
      const gw = fakeGateway(autoProfileRoute);
      const out = await createRoutingHandler(deps(routingAct, gw))(withMode(undefined), {
        signal,
        paseo: paseoWithProfile,
      });
      assert.equal(out?.config.modeId, 'auto');
    });

    it('does not route a pinned agent to another provider', async () => {
      const gw = fakeGateway(() =>
        response({
          policy: 'routing',
          action: 'route:fast',
          mode: 'act',
          enforced: true,
          route: { preset: 'fast', model: 'claude/haiku', mode: 'auto' },
        }),
      );
      const out = await createRoutingHandler(deps(routingAct, gw))(withMode('default', 'codex'), {
        signal,
      });
      assert.equal(out, undefined);
    });
  });

  it('applies a preset of a user-written routing variant', async () => {
    const gw = fakeGateway(() =>
      response({
        policy: 'routing',
        variant: 'routing-mine',
        action: 'route:cheap',
        mode: 'act',
        enforced: true,
      }),
    );
    const mine = { ...routingAct, presets: { cheap: { model: 'codex/gpt-mini', modeId: '' } } };
    const out = await createRoutingHandler(deps(mine, gw))(createRequest('Docs'), { signal });
    assert.equal(out?.config.provider, 'codex');
    assert.equal(out?.config.model, 'gpt-mini');
  });

  it('changes nothing when unmapped, not enforced, without a prompt, or on failure', async () => {
    const cases = [
      [routingAct, response({ action: 'route:standard', mode: 'act', enforced: true })],
      [routingAct, response({ action: 'route:fast', mode: 'shadow', enforced: false })],
      [settings(), response({ action: 'route:fast', mode: 'act', enforced: true })],
      [routingAct, null],
    ] as const;
    for (const [s, res] of cases) {
      assert.equal(
        await createRoutingHandler(
          deps(
            s,
            fakeGateway(() => res),
          ),
        )(createRequest('Task'), { signal }),
        undefined,
      );
    }
    const gw = fakeGateway(() => response());
    assert.equal(
      await createRoutingHandler(deps(routingAct, gw))(createRequest(null), { signal }),
      undefined,
    );
    assert.equal(gw.calls.length, 0);
  });

  it('never waits in shadow mode but still sends the decision for the log', async () => {
    const slow = fakeGateway(async () => new Promise(() => {}));
    const started = Date.now();
    const out = await createRoutingHandler(deps(settings(), slow))(createRequest('Task'), {
      signal,
    });
    assert.equal(out, undefined);
    assert.ok(Date.now() - started < 50);
    assert.equal(slow.calls.length, 1);
  });

  it('gives up within its budget and never throws', async () => {
    const slow = fakeGateway(async () => new Promise(() => {}));
    const started = Date.now();
    const out = await createRoutingHandler(deps(routingAct, slow), 100)(createRequest('Task'), {
      signal,
    });
    assert.equal(out, undefined);
    assert.ok(Date.now() - started < 1000);

    const broken = deps(routingAct, null);
    broken.settings = async () => {
      throw new Error('settings exploded');
    };
    assert.equal(await createRoutingHandler(broken)(createRequest('Task'), { signal }), undefined);
    assert.match(broken.logs[0] ?? '', /settings exploded/);
  });

  it('skips the gateway entirely while it is known to be down', async () => {
    const gw = fakeGateway(() => response({ action: 'route:fast', mode: 'act', enforced: true }));
    const d = { ...deps(routingAct, gw), gatewayKnownDown: () => true };
    assert.equal(await createRoutingHandler(d)(createRequest('Task'), { signal }), undefined);
    assert.equal(gw.calls.length, 0);
  });

  it('skips internal agents', async () => {
    const gw = fakeGateway(() => response());
    const req = createRequest('Commit message');
    req.request.config.internal = true;
    assert.equal(await createRoutingHandler(deps(routingAct, gw))(req, { signal }), undefined);
    assert.equal(gw.calls.length, 0);
  });
});

const open = (purpose: 'interactive' | 'history'): { request: PluginSessionOpenRequest } => ({
  request: {
    agentId: 'a1',
    workspaceId: 'w1',
    provider: 'claude',
    cwd: '/p',
    reason: 'resume',
    purpose,
    title: null,
    labels: {},
    tools: [],
    env: {},
    mcpServers: {},
  },
});

describe('agent.open.before', () => {
  it('injects the gateway MCP server only when enabled', async () => {
    const gw = fakeGateway(() => null);
    const on = createOpenHandler(deps(settings({ injectMcp: true }), gw), () => undefined);
    const out = await on(open('interactive'));
    assert.deepEqual(out?.mcpServers, {
      'local-decider': { type: 'http', url: 'http://127.0.0.1:8765/mcp' },
    });
    assert.equal(await on(open('history')), undefined);
    const off = await createOpenHandler(deps(settings(), gw), () => undefined)(open('interactive'));
    assert.deepEqual(off?.mcpServers, {});
  });

  it('tells the harness hooks which policies Paseo runs', async () => {
    const gw = fakeGateway(() => null);
    const out = await createOpenHandler(deps(settings(), gw), () => undefined)(open('interactive'));
    assert.equal(out?.env['LOCAL_DECIDER_HOST_POLICIES'], 'turn-outcome,permission,routing');
  });

  it('keeps policies already listed in the env', () => {
    const env = hostEnv({ PATH: '/bin', LOCAL_DECIDER_HOST_POLICIES: 'command-risk, routing' });
    assert.equal(env['PATH'], '/bin');
    assert.equal(
      env['LOCAL_DECIDER_HOST_POLICIES'],
      'command-risk,routing,turn-outcome,permission',
    );
  });

  it('adds a bearer header only when a token is set and the URL is https or loopback', () => {
    assert.deepEqual(mcpServerConfig('https://h', 't'), {
      type: 'http',
      url: 'https://h/mcp',
      headers: { authorization: 'Bearer t' },
    });
    assert.deepEqual(mcpServerConfig('http://127.0.0.1:8765', 't'), {
      type: 'http',
      url: 'http://127.0.0.1:8765/mcp',
      headers: { authorization: 'Bearer t' },
    });
    assert.equal(
      'headers' in mcpServerConfig('http://h', 't'),
      false,
      'never in clear text to another host',
    );
  });
});

describe('rpc handlers', () => {
  it('tracks the down streak for client backoff', async () => {
    const up = fakeGateway(() => null);
    let healthy = false;
    up.health = async () => (healthy ? { status: 'ok', model: 'm', p50Ms: 5 } : null);
    const status = createStatusHandler(deps(settings(), up), () => new Date(0));
    assert.equal((await status()).downStreak, 1);
    assert.equal((await status()).downStreak, 2);
    healthy = true;
    const ok = await status();
    assert.deepEqual(ok, {
      up: true,
      status: 'ok',
      engine: null,
      engineTag: null,
      engineState: null,
      detail: null,
      model: 'm',
      p50Ms: 5,
      gatewayUrl: 'http://127.0.0.1:8765',
      downStreak: 0,
      checkedAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('manual decide appends an unenforced row, and throws when the gateway is down', async () => {
    const gw = fakeGateway(() =>
      response({ policy: 'routing', action: 'route:fast', mode: 'act', enforced: true }),
    );
    const paseo = fakePaseo([]);
    const row = await manualDecide(deps(settings(), gw), paseo, {
      policy: 'routing',
      text: 'x',
      agentId: 'a1',
    });
    assert.equal(row.enforced, false);
    assert.deepEqual(gw.calls[0]?.input, { prompt: 'x' });
    assert.equal(paseo.agent.appended[0]?.id, 'local-decider-manual-d-1');
    await assert.rejects(
      manualDecide(
        deps(
          settings(),
          fakeGateway(() => null),
        ),
        paseo,
        { policy: 'routing', text: 'x', agentId: null },
      ),
      /no decision/,
    );
  });
});

describe('Background', () => {
  it('refuses work at capacity and after stop, and never rejects', async () => {
    const bg = new Background(1);
    const errors: unknown[] = [];
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    assert.equal(
      bg.run(
        async () => gate,
        (e) => errors.push(e),
      ),
      true,
    );
    assert.equal(
      bg.run(
        async () => {},
        (e) => errors.push(e),
      ),
      false,
    );
    release();
    await bg.idle();
    assert.equal(
      bg.run(
        async () => Promise.reject(new Error('x')),
        (e) => errors.push(e),
      ),
      true,
    );
    await bg.idle();
    assert.equal(errors.length, 1);
    bg.stop();
    assert.equal(
      bg.run(
        async () => {},
        () => {},
      ),
      false,
    );
  });
});
