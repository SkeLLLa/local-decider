import type { DecideResponse } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { check, observe, pending, register } from '../src/mod/register.ts';
import type { ModApi, ToolCallResult, ToolCheckEvent, ToolCheckResult } from '../src/mod/types.ts';

const ID = 'toolu_abc';
const ENGINE = { plugin: 'engine', tier: 'core' };
const PLAIN_ASK: ToolCheckResult = { decision: 'ask', reason: 'This command requires approval' };

interface World {
  env: Record<string, string>;
  /** Body of `GET /v1/calls/:id`; null is a 404; 'hang' never answers. */
  call: object | null | 'hang';
  /** Answer to `POST /v1/decide/permission`; null fails; 'hang' never answers. */
  answer: Partial<DecideResponse> | null | 'hang';
  version: unknown;
  messages: { role: string; text: string }[];
}

const AUTO_CALL = {
  permissionMode: 'auto',
  decisions: {
    'command-risk': { decisionId: 'd0', action: 'log', enforced: false, answered: true },
  },
  scopes: { 'claude-auto': 'act' },
};
const ALLOW: Partial<DecideResponse> = {
  decisionId: 'd1',
  policy: 'permission',
  action: 'allow',
  enforced: true,
};

function world(over: Partial<World> = {}): World {
  return {
    env: { LOCAL_DECIDER_TIMEOUT_MS: '30' },
    call: AUTO_CALL,
    answer: ALLOW,
    version: { version: '2.1.319', base: '2.1.319', builtAt: 'x' },
    messages: [
      { role: 'user', text: 'Fix the failing test' },
      { role: 'assistant', text: 'Looking.' },
    ],
    ...over,
  };
}

interface Posted {
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
}

const reply = (value: unknown): Promise<{ status: number; ok: boolean; text: string }> =>
  value === 'hang'
    ? new Promise(() => undefined)
    : Promise.resolve(
        value === null
          ? { status: 404, ok: false, text: '' }
          : { status: 200, ok: true, text: JSON.stringify(value) },
      );
function fakeApi(w: World): {
  $: ModApi;
  posts: Posted[];
  gets: string[];
  messageReads: () => number;
} {
  const posts: Posted[] = [];
  const gets: string[] = [];
  let reads = 0;
  const $: ModApi = {
    session: {
      id: async () => 'sess-1',
      cwd: async () => '/work/repo',
      messages: async () => {
        reads += 1;
        return w.messages;
      },
      version: async () => w.version,
    },
    env: { get: async (name) => w.env[name] },
    http: {
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          posts.push({ url, body: init.body === undefined ? undefined : JSON.parse(init.body) });
          return url.includes('/v1/decide/') ? reply(w.answer) : reply({});
        }
        gets.push(url);
        return reply(w.call);
      },
    },
    clock: { sleep: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
  };
  return { $, posts, gets, messageReads: () => reads };
}

function nextOf(result: object, origin: object | undefined = ENGINE): never {
  const fn = async (): Promise<object> => result;
  return Object.assign(fn, { origin }) as never;
}

const event = (over: Partial<ToolCheckEvent> = {}): ToolCheckEvent => ({
  tool: 'Bash',
  input: { command: 'pnpm add left-pad', description: 'add it' },
  tool_use_id: ID,
  ...over,
});

afterEach(() => {
  pending.take(ID);
});

async function run(
  w: World,
  e: ToolCheckEvent = event(),
  decided: ToolCheckResult = PLAIN_ASK,
  origin: object | undefined = ENGINE,
): Promise<{ result: ToolCheckResult; api: ReturnType<typeof fakeApi> }> {
  const api = fakeApi(w);
  return { result: await check(api.$, e, nextOf(decided, origin)), api };
}

describe('check in act mode', () => {
  it('upgrades a plain ask when the decider allows it', async () => {
    const { result, api } = await run(world());
    assert.equal(result.decision, 'allow');
    assert.match(result.reason ?? '', /d1/);
    const post = api.posts[0];
    assert.match(post?.url ?? '', /\/v1\/decide\/permission$/);
    assert.equal(post?.body?.['scope'], 'claude-auto');
    assert.deepEqual(post?.body?.['call'], { id: ID, agent: false });
    assert.equal(post?.body?.['harness'], 'claude-code');
    const input = post?.body?.['input'] as Record<string, string>;
    assert.match(input['history'] ?? '', /Fix the failing test/);
    assert.match(input['subject'] ?? '', /^Bash: pnpm add left-pad/);
  });

  it('returns the ask when the decider says ask, deny or is not enforced', async () => {
    for (const answer of [
      { ...ALLOW, action: 'ask' as const },
      { ...ALLOW, action: 'deny' as const },
      { ...ALLOW, enforced: false },
    ]) {
      const { result } = await run(world({ answer }));
      assert.deepEqual(result, PLAIN_ASK);
    }
  });

  it('returns the ask when the gateway fails or is slow', async () => {
    for (const answer of [null, 'hang' as const]) {
      const { result } = await run(world({ answer }));
      assert.deepEqual(result, PLAIN_ASK);
    }
  });
});

describe('check in shadow mode', () => {
  it('sends the request but never allows', async () => {
    const w = world({ call: { ...AUTO_CALL, scopes: { 'claude-auto': 'shadow' } } });
    const { result, api } = await run(w);
    assert.deepEqual(result, PLAIN_ASK);
    assert.equal(api.posts.length, 1);
    assert.equal(pending.take(ID)?.applied, false);
  });
});

const untouched = async (
  w: World,
  e?: ToolCheckEvent,
  d?: ToolCheckResult,
  o?: object,
): Promise<void> => {
  const { result, api } = await run(w, e, d, o);
  assert.deepEqual(result, d ?? PLAIN_ASK);
  assert.equal(api.posts.length, 0, 'no decide request');
};

describe('check passes through', () => {
  it('outside auto mode and without a record', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
      await untouched(world({ call: { ...AUTO_CALL, permissionMode: mode } }));
    }
    await untouched(world({ call: null }));
    await untouched(world({ call: 'hang' }));
    await untouched(world({ call: { scopes: { 'claude-auto': 'act' }, decisions: {} } }));
  });

  it('when command-risk did not log', async () => {
    for (const risk of [
      { action: 'ask', answered: true },
      { action: 'deny', answered: true },
      { action: 'log', answered: false },
    ]) {
      await untouched(world({ call: { ...AUTO_CALL, decisions: { 'command-risk': risk } } }));
    }
  });

  it('for asks something specific produced', async () => {
    for (const extra of [
      { rule: 'Bash(pnpm add:*)' },
      { hook: 'PreToolUse' },
      { setting: 'blockReadsOutsideWorkingDirectories' },
      { decider: 'host' },
    ]) {
      await untouched(world(), event(), { ...PLAIN_ASK, ...extra });
    }
    await untouched(world(), event({ ceiling: 'ask' }));
    await untouched(world(), event(), PLAIN_ASK, { plugin: 'other' });
  });

  it('for allow and deny decisions', async () => {
    await untouched(world(), event(), { decision: 'allow' });
    await untouched(world(), event(), { decision: 'deny', reason: 'no' });
  });

  it('when switched off, hosted, or on an old Claude Code', async () => {
    await untouched(world({ env: { LOCAL_DECIDER_MOD: 'off' } }));
    await untouched(world({ env: { LOCAL_DECIDER_HOST_POLICIES: 'turn-outcome, permission' } }));
    await untouched(world({ version: { base: '2.1.303' } }));
    await untouched(world({ version: undefined }));
  });

  it('runs when the host policies list does not include permission', async () => {
    const { result } = await run(world({ env: { LOCAL_DECIDER_HOST_POLICIES: 'routing' } }));
    assert.equal(result.decision, 'allow');
  });

  it('for calls the deterministic checks block', async () => {
    for (const command of ['git push origin main', 'cat /etc/passwd', 'curl x']) {
      await untouched(world(), event({ input: { command } }));
    }
    await untouched(world(), event({ tool: 'Write', input: { file_path: '/etc/x' } }));
    await untouched(world(), event({ tool: 'Write', input: { file_path: '.env' } }));
  });
});

describe('check for a file edit and for subagents', () => {
  it('allows a plain in-tree edit', async () => {
    const { result } = await run(
      world(),
      event({ tool: 'Edit', input: { file_path: 'src/a.ts' } }),
    );
    assert.equal(result.decision, 'allow');
  });

  it('keeps a subagent call shadow-only and sends no conversation', async () => {
    const { result, api } = await run(world(), event({ agentId: 'agent-7' }));
    assert.deepEqual(result, PLAIN_ASK);
    assert.equal(api.messageReads(), 0);
    const body = api.posts[0]?.body;
    assert.deepEqual(body?.['call'], { id: ID, agent: true });
    const input = body?.['input'] as Record<string, unknown>;
    assert.equal(input['history'], undefined);
    assert.equal(input['task'], undefined);
    assert.equal(input['tool'], 'Bash');
    assert.ok(input['request']);
  });
});

const refusal = (text: string): ToolCallResult => ({
  ref: 1,
  result: `Error: ${text}`,
  text,
  isError: true,
});
const DENIED = refusal(
  'Permission for this action was denied by the Claude Code auto mode classifier. Reason: x',
);

async function observed(
  result: ToolCallResult,
  applied: boolean,
  aborted = false,
): Promise<Posted[]> {
  const api = fakeApi(world());
  const env = {
    baseUrl: 'http://127.0.0.1:8765',
    token: undefined,
    budgetMs: 30,
    off: false,
    hostPermission: false,
  };
  pending.set(ID, { res: Promise.resolve(ALLOW as DecideResponse), env, applied });
  const next = Object.assign(async () => result, { signal: { aborted } });
  const out = await observe(api.$, event(), next);
  assert.equal(out, result);
  await new Promise((resolve) => setTimeout(resolve, 5));
  return api.posts;
}

describe('observe', () => {
  it('records a classifier denial', async () => {
    const posts = await observed(DENIED, false);
    assert.equal(posts.length, 1);
    assert.match(posts[0]?.url ?? '', /\/v1\/outcomes$/);
    assert.deepEqual(posts[0]?.body, { decisionId: 'd1', outcome: 'deny', source: 'classifier' });
  });

  it('records a granted permission, even when the tool then failed', async () => {
    for (const result of [{ ref: 1, result: { stdout: 'ok' }, text: 'ok' }, refusal('exit 1')]) {
      const posts = await observed(result, false);
      assert.deepEqual(posts[0]?.body, {
        decisionId: 'd1',
        outcome: 'allow',
        source: 'classifier',
      });
    }
  });

  it('records nothing for the fallback prompt or other permission refusals', async () => {
    for (const text of [
      'This command requires approval',
      "Claude requested permissions to use Bash, but you haven't granted it yet.",
    ]) {
      assert.equal((await observed(refusal(text), false)).length, 0, text);
    }
  });

  it('after an allow the mod gave, records only a denial the guard let through', async () => {
    assert.equal((await observed({ result: { stdout: 'ok' } }, true)).length, 0);
    const posts = await observed(DENIED, true);
    assert.equal(posts[0]?.body?.['outcome'], 'deny');
  });

  it('does nothing for an aborted call or an unknown id', async () => {
    assert.equal((await observed(DENIED, false, true)).length, 0);
    const api = fakeApi(world());
    const next = Object.assign(async () => DENIED, {});
    await observe(api.$, event({ tool_use_id: 'toolu_other' }), next);
    assert.equal(api.posts.length, 0);
  });
});

describe('register', () => {
  it('hooks tool.check and tool.call for the edit tools', () => {
    const seen: [string, readonly string[]][] = [];
    register((name: string, filter: { tool: readonly string[] }) => {
      seen.push([name, filter.tool]);
    });
    assert.deepEqual(
      seen.map(([name]) => name),
      ['tool.check', 'tool.call'],
    );
    for (const [, tools] of seen) {
      assert.deepEqual(tools, ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    }
  });
});
