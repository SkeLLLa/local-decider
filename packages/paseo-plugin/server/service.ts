/**
 * Start, stop or restart the gateway's user service. This is the only process the plugin spawns.
 * The argv is fixed per platform and action and never comes from settings or RPC input; it runs
 * through `execFile` (no shell) with a 20 s timeout. Without an installed user service there is
 * nothing to run, and the screen shows how to install one.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { ServiceAction } from '../shared/constants.ts';

const SYSTEMD_UNIT = 'local-decider.service';
const LAUNCHD_LABEL = 'dev.local-decider.gateway';
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 2000;

export interface ServiceEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly uid: number;
  exists(path: string): boolean;
}

export interface ServiceCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export type Manager = 'systemd' | 'launchd';

export function defaultServiceEnv(): ServiceEnv {
  return {
    platform: process.platform,
    home: homedir(),
    uid: userInfo().uid,
    exists: existsSync,
  };
}

function systemdUnitPath(env: ServiceEnv): string {
  return join(env.home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
}

function launchdPlistPath(env: ServiceEnv): string {
  return join(env.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

/** The service manager that has the gateway installed, if any. */
function serviceManager(env: ServiceEnv): Manager | null {
  if (env.platform === 'linux' && env.exists(systemdUnitPath(env))) {
    return 'systemd';
  }
  if (env.platform === 'darwin' && env.exists(launchdPlistPath(env))) {
    return 'launchd';
  }
  return null;
}

function launchdCommand(env: ServiceEnv, action: ServiceAction): ServiceCommand {
  const domain = `gui/${String(env.uid)}`;
  const args: Record<ServiceAction, string[]> = {
    start: ['bootstrap', domain, launchdPlistPath(env)],
    stop: ['bootout', `${domain}/${LAUNCHD_LABEL}`],
    restart: ['kickstart', '-k', `${domain}/${LAUNCHD_LABEL}`],
  };
  return { file: 'launchctl', args: args[action] };
}

/** The exact command for `action`, or null when no user service is installed. */
export function serviceCommand(env: ServiceEnv, action: ServiceAction): ServiceCommand | null {
  const manager = serviceManager(env);
  if (manager === 'systemd') {
    return { file: 'systemctl', args: ['--user', action, SYSTEMD_UNIT] };
  }
  return manager === 'launchd' ? launchdCommand(env, action) : null;
}

function commandText(command: ServiceCommand): string {
  return [command.file, ...command.args].join(' ');
}

export type Exec = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<{ code: number | null; output: string; error: string | null }>;

const execService: Exec = async (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (error === null) {
          resolve({ code: 0, output, error: null });
          return;
        }
        const killed = error.killed ?? false;
        resolve({
          code: typeof error.code === 'number' ? error.code : null,
          output,
          error: killed ? `timed out after ${String(timeoutMs / 1000)} s` : error.message,
        });
      },
    );
  });

export interface ServiceResult {
  readonly ok: boolean;
  readonly command: string | null;
  readonly output: string;
  readonly error: string | null;
}

export async function runService(
  env: ServiceEnv,
  action: ServiceAction,
  exec: Exec = execService,
): Promise<ServiceResult> {
  const command = serviceCommand(env, action);
  if (command === null) {
    return { ok: false, command: null, output: '', error: 'No gateway user service is installed.' };
  }
  const res = await exec(command.file, command.args, TIMEOUT_MS);
  return {
    ok: res.error === null,
    command: commandText(command),
    output: res.output.slice(0, MAX_OUTPUT),
    error: res.error === null ? null : res.error.slice(0, MAX_OUTPUT),
  };
}

/** What the screens show: the manager and the exact command behind each button. */
export function serviceInfo(env: ServiceEnv): {
  manager: Manager | null;
  commands: Record<ServiceAction, string> | null;
} {
  const start = serviceCommand(env, 'start');
  const stop = serviceCommand(env, 'stop');
  const restart = serviceCommand(env, 'restart');
  if (start === null || stop === null || restart === null) {
    return { manager: null, commands: null };
  }
  return {
    manager: serviceManager(env),
    commands: { start: commandText(start), stop: commandText(stop), restart: commandText(restart) },
  };
}
