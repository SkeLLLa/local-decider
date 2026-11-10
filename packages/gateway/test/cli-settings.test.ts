import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  configCommand,
  routingCommand,
  setMode,
  SettingsUsageError,
  useVariant,
} from '../src/cli-settings.ts';
import { ConfigFile } from '../src/config-file.ts';
import { tempPaths } from './helpers.ts';

describe('settings commands', () => {
  it('map and unmap presets per harness in config.yaml', () => {
    const paths = tempPaths();
    routingCommand(paths, ['map', 'paseo', 'cheap', 'claude/haiku', 'plan']);
    routingCommand(paths, ['map', 'codex', 'deep', 'gpt-5.5']);
    assert.deepEqual(ConfigFile.open(paths).current.routing.presets, {
      paseo: { cheap: { model: 'claude/haiku', mode: 'plan' } },
      codex: { deep: { model: 'gpt-5.5' } },
    });
    routingCommand(paths, ['unmap', 'codex', 'deep']);
    assert.deepEqual(JSON.parse(routingCommand(paths, [])), {
      paseo: { cheap: { model: 'claude/haiku', mode: 'plan' } },
    });
    assert.throws(() => routingCommand(paths, ['map', 'vim', 'x', 'y']), SettingsUsageError);
  });

  it('map thinking, mode and Paseo profiles with flags', () => {
    const paths = tempPaths();
    const presets = (): unknown => ConfigFile.open(paths).current.routing.presets;
    assert.equal(
      routingCommand(paths, ['map', 'paseo', 'fast', 'codex/gpt-6-luna', '--thinking', 'xhigh']),
      'route:fast → codex/gpt-6-luna (thinking xhigh) for paseo',
    );
    assert.equal(
      routingCommand(paths, ['map', 'paseo', 'deep', '--profile', 'design-opus']),
      'route:deep → profile design-opus for paseo',
    );
    assert.equal(
      routingCommand(paths, ['map', 'paseo', 'plan', 'claude/opus', '--mode', 'plan']),
      'route:plan → claude/opus (mode plan) for paseo',
    );
    assert.equal(
      routingCommand(paths, ['map', 'codex', 'deep', 'gpt-5.5', '--thinking', 'high']),
      'route:deep → gpt-5.5 (thinking high) for codex',
    );
    // A new mapping replaces the old target whole: thinking does not linger.
    routingCommand(paths, ['map', 'paseo', 'fast', 'codex/gpt-6-luna', 'full-access']);
    assert.deepEqual(presets(), {
      paseo: {
        fast: { model: 'codex/gpt-6-luna', mode: 'full-access' },
        deep: { profile: 'design-opus' },
        plan: { model: 'claude/opus', mode: 'plan' },
      },
      codex: { deep: { model: 'gpt-5.5', thinking: 'high' } },
    });
  });

  it('reject Paseo-only fields elsewhere, missing targets and bad flags', () => {
    const paths = tempPaths();
    assert.throws(
      () => routingCommand(paths, ['map', 'codex', 'deep', '--profile', 'design-opus']),
      (error) =>
        error instanceof SettingsUsageError && /--profile is Paseo only/.test(error.message),
    );
    assert.throws(
      () => routingCommand(paths, ['map', 'claude-code', 'x', 'haiku', '--mode', 'plan']),
      /--mode is Paseo only/,
    );
    assert.throws(
      () => routingCommand(paths, ['map', 'paseo', 'x', '--thinking', 'high']),
      /needs a model or --profile/,
    );
    assert.throws(
      () => routingCommand(paths, ['map', 'paseo', 'x', 'm', '--loud']),
      SettingsUsageError,
    );
    assert.throws(
      () => routingCommand(paths, ['map', 'paseo', 'x', 'm', 'plan', '--mode', 'plan']),
      SettingsUsageError,
    );
    assert.deepEqual(ConfigFile.open(paths).current.routing.presets, {});
  });

  it('leave config.yaml unchanged when a value fails the schema', () => {
    const paths = tempPaths();
    routingCommand(paths, ['map', 'paseo', 'fast', 'codex/gpt-6-luna']);
    const store = ConfigFile.open(paths);
    const before = readFileSync(store.file, 'utf8');
    assert.throws(
      () =>
        routingCommand(paths, [
          'map',
          'paseo',
          'fast',
          'claude/opus',
          '--thinking',
          'x'.repeat(101),
        ]),
      /routing\.presets\.paseo\.fast\.thinking/,
    );
    assert.equal(readFileSync(store.file, 'utf8'), before);
  });

  it('choose only real variants, and set modes', () => {
    const paths = tempPaths();
    assert.equal(useVariant(paths, 'routing', 'routing-budget'), 'routing → routing-budget');
    assert.throws(() => useVariant(paths, 'routing', 'permission'), /not a variant of routing/);
    assert.throws(() => useVariant(paths, 'routing-budget', 'routing'), /no policy/);
    setMode(paths, 'routing', 'act');
    assert.deepEqual(ConfigFile.open(paths).current.policies, {
      routing: { variant: 'routing-budget', mode: 'act' },
    });
    useVariant(paths, 'routing', 'routing');
    assert.deepEqual(ConfigFile.open(paths).current.policies, { routing: { mode: 'act' } });
    assert.throws(() => setMode(paths, 'routing', 'loud'), SettingsUsageError);
  });

  it('write schemas, check the file and print where things are', () => {
    const paths = tempPaths();
    const written = configCommand(paths, ['schema']).split('\n');
    assert.ok(written.every((file) => existsSync(file)));
    assert.match(readFileSync(written[0] ?? '', 'utf8'), /"title": "local-decider config.yaml"/);
    assert.match(configCommand(paths, ['check']), /: ok$/);
    assert.match(configCommand(paths, []), new RegExp(join(paths.config, 'config.yaml')));
  });
});
