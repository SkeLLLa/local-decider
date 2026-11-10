import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function hook(event: string, payload: unknown): { stdout: string; status: number | null } {
  const res = spawnSync(process.execPath, ['--conditions=source', main, 'claude', event], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      LOCAL_DECIDER_URL: 'http://127.0.0.1:1',
      LOCAL_DECIDER_TIMEOUT_MS: '300',
    },
    timeout: 10_000,
  });
  return { stdout: res.stdout, status: res.status };
}

describe('main (process wrapper)', () => {
  const base = { session_id: 's', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'Bash' };

  it('prints a guard deny and exits 0', () => {
    const res = hook('PreToolUse', { ...base, tool_input: { command: 'rm -rf /' } });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /"permissionDecision":"deny"/);
  });

  it('prints nothing and exits 0 when the gateway is down', () => {
    const res = hook('PreToolUse', { ...base, tool_input: { command: 'ls' } });
    assert.deepEqual(res, { stdout: '', status: 0 });
  });
});
