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
    const start = serviceCommand(mac, 'start');
    assert.deepEqual([start?.file, start?.args], ['launchctl', ['bootstrap', 'gui/501', PLIST]]);
    assert.deepEqual(start?.fallback?.args, ['kickstart', 'gui/501/dev.local-decider.gateway']);
    assert.deepEqual(serviceCommand(mac, 'stop'), {
      file: 'launchctl',
      args: ['bootout', 'gui/501/dev.local-decider.gateway'],
    });
    const restart = serviceCommand(mac, 'restart');
    assert.deepEqual(restart?.args, ['kickstart', '-k', 'gui/501/dev.local-decider.gateway']);
    assert.deepEqual(restart?.fallback?.args, ['bootstrap', 'gui/501', PLIST]);
    assert.equal(serviceCommand(mac, 'stop')?.fallback, undefined);
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

/** An exec that answers each call in turn and records the argv. */
function script(...answers: { code: number | null; output: string }[]): {
  exec: Exec;
  calls: (readonly string[])[];
} {
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    const a = answers[calls.length - 1] ?? { code: 0, output: '' };
    return { ...a, error: a.code === 0 ? null : `exit ${String(a.code)}` };
  };
  return { exec, calls };
}

describe('launchd fallbacks', () => {
  const mac = env('darwin', [PLIST]);
  const KICK = ['kickstart', 'gui/501/dev.local-decider.gateway'];
  const BOOT = ['bootstrap', 'gui/501', PLIST];

  it('start kickstarts when the agent is already loaded', async () => {
    for (const first of [
      { code: 5, output: 'Bootstrap failed: 5: Input/output error' },
      { code: 37, output: 'Operation already in progress' },
      { code: 1, output: 'service already loaded' },
    ]) {
      const { exec, calls } = script(first, { code: 0, output: '' });
      const res = await runService(mac, 'start', exec);
      assert.deepEqual(calls, [BOOT, KICK]);
      assert.equal(res.ok, true);
      assert.equal(res.command, `launchctl ${KICK.join(' ')}`);
    }
  });

  it('restart bootstraps when the agent is not loaded', async () => {
    for (const first of [
      { code: 113, output: '' },
      { code: 1, output: 'Could not find service "dev.local-decider.gateway"' },
    ]) {
      const { exec, calls } = script(first, { code: 0, output: '' });
      const res = await runService(mac, 'restart', exec);
      assert.deepEqual(calls, [['kickstart', '-k', KICK[1]], BOOT]);
      assert.equal(res.ok, true);
    }
  });

  it('does not fall back on unrelated errors, success or stop', async () => {
    const start = script({ code: 2, output: 'No such file or directory' });
    assert.equal((await runService(mac, 'start', start.exec)).ok, false);
    assert.equal(start.calls.length, 1);
    const restart = script({ code: 0, output: 'Could not find service' });
    assert.equal((await runService(mac, 'restart', restart.exec)).ok, true);
    assert.equal(restart.calls.length, 1);
    const stop = script({ code: 113, output: 'Could not find service' });
    await runService(mac, 'stop', stop.exec);
    assert.equal(stop.calls.length, 1);
  });

  it('reports the fallback failing', async () => {
    const { exec } = script({ code: 5, output: '' }, { code: 3, output: 'boom' });
    const res = await runService(mac, 'start', exec);
    assert.equal(res.ok, false);
    assert.equal(res.output, 'boom');
  });

  it('shows both commands to the user', () => {
    const info = serviceInfo(mac);
    assert.match(info.commands?.start ?? '', /bootstrap .*\(if that fails: launchctl kickstart /);
    assert.match(
      info.commands?.restart ?? '',
      /kickstart -k .*\(if that fails: launchctl bootstrap /,
    );
    assert.equal(info.commands?.stop, 'launchctl bootout gui/501/dev.local-decider.gateway');
  });
});
