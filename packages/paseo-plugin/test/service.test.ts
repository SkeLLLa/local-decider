import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runService,
  serviceCommand,
  serviceInfo,
  type Exec,
  type ServiceEnv,
} from '../server/service.ts';

function env(platform: NodeJS.Platform, present: readonly string[]): ServiceEnv {
  return { platform, home: '/home/u', uid: 501, exists: (path) => present.includes(path) };
}

const failing: Exec = async () => ({ code: 5, output: 'Unit not found.', error: 'exit 5' });

const UNIT = '/home/u/.config/systemd/user/local-decider.service';
const PLIST = '/home/u/Library/LaunchAgents/dev.local-decider.gateway.plist';

describe('service argv', () => {
  it('uses systemctl --user on Linux with the unit installed', () => {
    const linux = env('linux', [UNIT]);
    for (const action of ['start', 'stop', 'restart'] as const) {
      assert.deepEqual(serviceCommand(linux, action), {
        file: 'systemctl',
        args: ['--user', action, 'local-decider.service'],
      });
    }
  });

  it('uses launchctl on macOS with the plist installed', () => {
    const mac = env('darwin', [PLIST]);
    assert.deepEqual(serviceCommand(mac, 'start'), {
      file: 'launchctl',
      args: ['bootstrap', 'gui/501', PLIST],
    });
    assert.deepEqual(serviceCommand(mac, 'stop'), {
      file: 'launchctl',
      args: ['bootout', 'gui/501/dev.local-decider.gateway'],
    });
    assert.deepEqual(serviceCommand(mac, 'restart'), {
      file: 'launchctl',
      args: ['kickstart', '-k', 'gui/501/dev.local-decider.gateway'],
    });
  });

  it('has nothing to run without an installed service, or on another platform', () => {
    assert.equal(serviceCommand(env('linux', []), 'start'), null);
    assert.equal(serviceCommand(env('darwin', [UNIT]), 'start'), null);
    assert.equal(serviceCommand(env('linux', [PLIST]), 'start'), null);
    assert.equal(serviceCommand(env('win32', [UNIT, PLIST]), 'start'), null);
    assert.deepEqual(serviceInfo(env('win32', [])), { manager: null, commands: null });
  });

  it('describes each button with its exact command', () => {
    assert.deepEqual(serviceInfo(env('linux', [UNIT])), {
      manager: 'systemd',
      commands: {
        start: 'systemctl --user start local-decider.service',
        stop: 'systemctl --user stop local-decider.service',
        restart: 'systemctl --user restart local-decider.service',
      },
    });
  });
});

describe('runService', () => {
  it('runs the fixed argv with a 20 s timeout and reports the result', async () => {
    const calls: unknown[] = [];
    const exec: Exec = async (file, args, timeoutMs) => {
      calls.push([file, args, timeoutMs]);
      return { code: 0, output: '', error: null };
    };
    const res = await runService(env('linux', [UNIT]), 'restart', exec);
    assert.deepEqual(calls, [
      ['systemctl', ['--user', 'restart', 'local-decider.service'], 20_000],
    ]);
    assert.deepEqual(res, {
      ok: true,
      command: 'systemctl --user restart local-decider.service',
      output: '',
      error: null,
    });
  });

  it('reports failures and never runs anything without a service', async () => {
    const res = await runService(env('linux', [UNIT]), 'start', failing);
    assert.equal(res.ok, false);
    assert.equal(res.output, 'Unit not found.');
    let ran = false;
    const none = await runService(env('linux', []), 'start', async () => {
      ran = true;
      return { code: 0, output: '', error: null };
    });
    assert.equal(ran, false);
    assert.equal(none.ok, false);
    assert.equal(none.command, null);
  });
});
