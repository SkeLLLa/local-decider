import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_MODEL, isLoopback, loadConfig, parseConfig } from '../src/config.ts';
import { resolvePaths } from '../src/paths.ts';
import { loadPolicies } from '../src/policies.ts';
import { launchdPlist, systemdUnit } from '../src/service.ts';
import { tempPaths } from './helpers.ts';

describe('config', () => {
  it('defaults to loopback and the 2B strands-decider model', () => {
    const config = parseConfig(undefined);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 8765);
    assert.equal(config.engine.type, 'strands-decider');
    assert.equal(config.engine.model, DEFAULT_MODEL);
    assert.deepEqual(config.logs, { retainDays: 365 });
  });

  it('validates the decision log retention window', () => {
    assert.equal(parseConfig({ logs: { retainDays: 90 } }).logs.retainDays, 90);
    assert.throws(() => parseConfig({ logs: { retainDays: 89 } }), /invalid config/);
    assert.throws(() => parseConfig({ logs: { retainDays: 3651 } }), /invalid config/);
  });

  it('rejects unknown keys', () => {
    assert.throws(() => parseConfig({ nope: 1 }), /invalid config/);
  });

  it('loads config.yaml and picks up the user policy dir', () => {
    const paths = tempPaths();
    mkdirSync(join(paths.config, 'policies'), { recursive: true });
    writeFileSync(
      join(paths.config, 'config.yaml'),
      'port: 9999\npolicies:\n  permission: { mode: act }\n',
    );
    const config = loadConfig(paths);
    assert.equal(config.port, 9999);
    assert.deepEqual(config.policyDirs, [join(paths.config, 'policies')]);
    assert.equal(loadPolicies(config).get('permission')?.mode, 'act');
  });

  it('lets a user policy replace a default by id', () => {
    const paths = tempPaths();
    const dir = join(paths.config, 'policies');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'routing.yaml'),
      'id: routing\nversion: 1\ndescription: mine\nmode: off\nstate: { sections: [{ label: P, from: prompt }] }\nquestions:\n  q: { type: noul, instructions: Hard? }\n',
    );
    const policies = loadPolicies(loadConfig(paths));
    assert.equal(policies.get('routing')?.policy.description, 'mine');
    assert.equal(policies.get('routing')?.mode, 'off');
    assert.equal(policies.size, 6, 'replaced, not added');
  });

  it('recognises loopback hosts', () => {
    assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && isLoopback('localhost'));
    assert.ok(!isLoopback('0.0.0.0'));
  });

  it('resolves XDG paths and the LOCAL_DECIDER_HOME override', () => {
    assert.equal(resolvePaths({ XDG_DATA_HOME: '/x' }).data, '/x/local-decider');
    assert.equal(resolvePaths({ LOCAL_DECIDER_HOME: '/h' }).logs, '/h/logs');
    assert.equal(resolvePaths({ XDG_CONFIG_HOME: '/c' }).config, '/c/local-decider');
  });
});

describe('service files', () => {
  const paths = tempPaths();
  const command = ['/usr/bin/node', '/opt/my app/cli.js', 'gateway', 'run'];

  it('writes a systemd unit with quoted args and an optional EnvironmentFile, no secrets', () => {
    const unit = systemdUnit(command, paths);
    assert.match(unit, /ExecStart=\/usr\/bin\/node "\/opt\/my app\/cli.js" gateway run/);
    assert.match(unit, /EnvironmentFile=-.*\/env/);
    assert.doesNotMatch(unit, /TOKEN/);
  });

  it('writes an escaped launchd plist', () => {
    const plist = launchdPlist(['/a&b', 'gateway'], paths);
    assert.match(plist, /<string>\/a&amp;b<\/string>/);
    assert.match(plist, /dev\.local-decider\.gateway/);
  });
});
