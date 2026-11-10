import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where runtime data lives. Never inside a plugin directory: `paseo plugin remove` deletes those. */
export interface Paths {
  readonly data: string;
  readonly config: string;
  readonly logs: string;
  readonly venvs: string;
  readonly run: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  const data =
    env['LOCAL_DECIDER_HOME'] ??
    join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'local-decider');
  const config =
    env['LOCAL_DECIDER_CONFIG_DIR'] ??
    join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'local-decider');
  return {
    data,
    config,
    logs: join(data, 'logs'),
    venvs: join(data, 'venvs'),
    run: join(data, 'run'),
  };
}
