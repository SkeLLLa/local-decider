// Run with `claude plugin test` (see `mise run test:mod`). Stubs stand in for the engine's
// permission flow (`tool.check`), the gateway (`http.fetch`), the environment and the clock.
import { expect, test } from 'claude-code/testing';

const AUTO_CALL = {
  permissionMode: 'auto',
  decisions: {
    'command-risk': { decisionId: 'd0', action: 'log', enforced: false, answered: true },
  },
  scopes: { 'claude-auto': 'act' },
};
const ALLOW = { decisionId: 'd1', policy: 'permission', action: 'allow', enforced: true };

interface Reply {
  value: { status: number; ok: boolean; headers: object; text: string };
}
type On = (event: string, handler: (...args: never[]) => unknown) => void;
interface Result {
  decision: string;
}

const reply = (body: unknown): Reply => ({
  value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) },
});

const check = async (
  $: { tool: { check(e: object): Promise<Result> } },
  over: object = {},
): Promise<Result> =>
  $.tool.check({
    tool: 'Bash',
    input: { command: 'pnpm add left-pad' },
    tool_use_id: 'toolu_test',
    ...over,
  });

function stubs(
  on: On,
  call: object,
  env: Record<string, string> = {},
  checked: object = { decision: 'ask', reason: 'This command requires approval' },
  version = '2.1.319',
): string[] {
  const seen: string[] = [];
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: env[e.name] }));
  // The budget timer must lose the race against the stubbed gateway, so it fires late.
  on('clock.sleep', async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { value: undefined };
  });
  on('http.fetch', (_$: unknown, e: { url: string }) => {
    seen.push(e.url);
    return e.url.includes('/v1/calls/') ? reply(call) : reply(ALLOW);
  });
  on('session.version', () => ({ value: { version, base: version, builtAt: 'x' } }));
  on('session.cwd', () => ({ value: '/work/repo' }));
  on('session.id', () => ({ value: 'sess-1' }));
  on('session.messages', () => ({ value: [{ role: 'user', text: 'Add left-pad' }] }));
  on('tool.check', () => checked);
  return seen;
}

test('act mode in auto mode turns a plain ask into an allow', async ($, on) => {
  const seen = stubs(on, AUTO_CALL);
  const result = await check($);
  expect(result.decision).toBe('allow');
  expect(seen.some((url) => url.endsWith('/v1/calls/toolu_test'))).toBe(true);
});

test('shadow scope never allows', async ($, on) => {
  stubs(on, { ...AUTO_CALL, scopes: { 'claude-auto': 'shadow' } });
  expect((await check($)).decision).toBe('ask');
});

test('outside auto mode the ask stands', async ($, on) => {
  stubs(on, { ...AUTO_CALL, permissionMode: 'dontAsk' });
  expect((await check($)).decision).toBe('ask');
});

test('a command the deterministic checks block is left to the classifier', async ($, on) => {
  stubs(on, AUTO_CALL);
  expect((await check($, { input: { command: 'git push origin main' } })).decision).toBe('ask');
});

test('LOCAL_DECIDER_MOD=off skips the mod', async ($, on) => {
  stubs(on, AUTO_CALL, { LOCAL_DECIDER_MOD: 'off' });
  expect((await check($)).decision).toBe('ask');
});

test('an ask rule is never upgraded', async ($, on) => {
  stubs(on, AUTO_CALL, {}, { decision: 'ask', reason: 'rule', rule: 'Bash(pnpm add:*)' });
  expect((await check($)).decision).toBe('ask');
});

test('a Paseo host that runs the permission policy skips the mod', async ($, on) => {
  stubs(on, AUTO_CALL, { LOCAL_DECIDER_HOST_POLICIES: 'turn-outcome,permission,routing' });
  expect((await check($)).decision).toBe('ask');
});

test('an old Claude Code is left alone', async ($, on) => {
  stubs(on, AUTO_CALL, {}, undefined, '2.1.290');
  expect((await check($)).decision).toBe('ask');
});
