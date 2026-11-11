import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  launchdEnv,
  launchdPlist,
  startLaunchd,
  systemdUnit,
  type LaunchctlDeps,
} from '../src/service.ts';
import { tempPaths } from './helpers.ts';

const COMMAND = ['/opt/node/bin/node', '/app/cli.ts', 'gateway', 'run'];

describe('launchd environment', () => {
  it('builds a deduplicated PATH and passes data-dir variables through', () => {
    const env = launchdEnv(
      {
        HOME: '/Users/me',
        LOCAL_DECIDER_HOME: '/data',
        XDG_DATA_HOME: '/xdg',
        HF_HOME: '',
        LOCAL_DECIDER_TOKEN: 'secret',
        OPENAI_API_KEY: 'k',
      },
      '/opt/homebrew/bin/node',
      { uv: '/Users/me/.local/bin/uv' },
    );
    assert.equal(
      env['PATH'],
      '/opt/homebrew/bin:/Users/me/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    assert.deepEqual(
      Object.keys(env).toSorted(),
      ['HOME', 'LOCAL_DECIDER_HOME', 'PATH', 'XDG_DATA_HOME'].toSorted(),
    );
  });

  it('writes an escaped environment dict and never a token', () => {
    const paths = tempPaths();
    const env = launchdEnv({ HOME: '/Users/a&b', LOCAL_DECIDER_TOKEN: 'secret' }, '/n/node', {});
    const plist = launchdPlist(
      ['/n/node', '--env-file-if-exists=/c/env', '/app/cli.ts'],
      paths,
      env,
    );
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /<key>HOME<\/key>\s*<string>\/Users\/a&amp;b<\/string>/);
    assert.doesNotMatch(plist, /LOCAL_DECIDER_TOKEN|secret/);
    assert.match(plist, /<string>\/app\/cli\.ts<\/string>/);
    assert.match(plist, /--env-file-if-exists=\/c\/env/);
    assert.doesNotMatch(systemdUnit(COMMAND, paths), /env-file-if-exists/);
  });
});

interface Fake {
  readonly deps: LaunchctlDeps;
  readonly calls: string[];
  readonly sleeps: number[];
}

/** A fake launchctl: `print` follows `loaded`, `bootstrap` fails with the given outcomes first. */
function fake(options: {
  loaded: () => boolean;
  unload?: () => void;
  bootstrapFailures?: string[];
  plist: string;
}): Fake {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const failures = [...(options.bootstrapFailures ?? [])];
  const deps: LaunchctlDeps = {
    uid: 501,
    plist: options.plist,
    sleep: (ms) => void sleeps.push(ms),
    tryRun: (args) => {
      calls.push(args[0] ?? '');
      return args[0] === 'print' && options.loaded() ? 'state = running' : undefined;
    },
    run: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'bootstrap' && failures.length > 0) {
        throw Object.assign(new Error(failures.shift()), { status: 5 });
      }
      return '';
    },
  };
  return { deps, calls, sleeps };
}

function start(f: Fake, restart: boolean, paths = tempPaths()): string {
  return startLaunchd(COMMAND, paths, restart, f.deps, { PATH: '/bin' });
}

describe('startLaunchd', () => {
  it('bootstraps when not loaded', () => {
    const paths = tempPaths();
    const f = fake({ loaded: () => false, plist: join(paths.data, 'a.plist') });
    assert.match(start(f, false, paths), /loaded/);
    assert.deepEqual(f.calls, ['print', `bootstrap gui/501 ${join(paths.data, 'a.plist')}`]);
    assert.match(readFileSync(join(paths.data, 'a.plist'), 'utf8'), /--env-file-if-exists=/);
  });

  it('leaves an unchanged loaded agent alone, or kickstarts it on restart', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    start(fake({ loaded: () => false, plist }), false, paths);
    const idle = fake({ loaded: () => true, plist });
    assert.match(start(idle, false, paths), /already loaded/);
    assert.deepEqual(idle.calls, ['print']);
    const kick = fake({ loaded: () => true, plist });
    assert.match(start(kick, true, paths), /restarted/);
    assert.deepEqual(kick.calls, ['print', 'kickstart -k gui/501/dev.local-decider.gateway']);
  });

  it('boots out a changed plist, waits for the unload, then bootstraps', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    let prints = 0;
    const f = fake({ loaded: () => ++prints <= 3, plist });
    start(f, false, paths);
    assert.deepEqual(
      f.calls.filter((c) => c !== 'print'),
      ['bootout', `bootstrap gui/501 ${plist}`],
    );
    assert.deepEqual(f.sleeps, [100, 100]);
  });

  it('retries bootstrap on EIO and gives up after three retries', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    const eio = 'Bootstrap failed: 5: Input/output error';
    const ok = fake({ loaded: () => false, bootstrapFailures: [eio], plist });
    start(ok, false, paths);
    assert.deepEqual(ok.sleeps, [500]);
    const bad = fake({
      loaded: () => false,
      bootstrapFailures: [eio, eio, eio, eio],
      plist: `${plist}2`,
    });
    assert.throws(() => start(bad, false, paths), /after 4 attempt/);
    assert.deepEqual(bad.sleeps, [500, 500, 500]);
  });

  it('fails when launchd never unloads the old job', () => {
    const paths = tempPaths();
    const plist = join(paths.data, 'a.plist');
    const f = fake({ loaded: () => true, plist });
    assert.throws(() => start(f, false, paths), /did not unload/);
    assert.equal(f.sleeps.length, 50);
  });
});
