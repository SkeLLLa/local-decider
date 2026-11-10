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
