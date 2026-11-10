import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import type { Paths } from './paths.ts';

export const SERVICE_NAME = 'local-decider';
export const LAUNCHD_LABEL = 'dev.local-decider.gateway';

/** The argv that runs `gateway run` with the same node and flags as this process. */
export function gatewayCommand(): string[] {
  const script = process.argv[1] ?? '';
  return [process.execPath, ...process.execArgv, script, 'gateway', 'run'];
}

function systemdQuote(arg: string): string {
  return /^[\w./:=@+-]+$/.test(arg)
    ? arg
    : `"${arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * A systemd user unit. A remote-mode token goes in the user-managed, optional EnvironmentFile
 * (`~/.config/local-decider/env`, mode 0600); this unit never contains one.
 */
export function systemdUnit(command: readonly string[], paths: Paths): string {
  return [
    '[Unit]',
    'Description=local-decider gateway (local decision models)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${command.map(systemdQuote).join(' ')}`,
    `EnvironmentFile=-${join(paths.config, 'env')}`,
    'Restart=on-failure',
    'RestartSec=5',
    'NoNewPrivileges=true',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xmlEscape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function launchdPlist(command: readonly string[], paths: Paths): string {
  const args = command.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(paths.logs, 'gateway.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(paths.logs, 'gateway.log'))}</string>
</dict>
</plist>
`;
}

export type ServiceManager = 'systemd' | 'launchd' | 'pidfile';

export function detectManager(): ServiceManager {
  if (process.platform === 'darwin') {
    return 'launchd';
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'is-system-running'], { stdio: 'ignore' });
      return 'systemd';
    } catch (error) {
      // `degraded` exits non-zero but systemd is still usable.
      return (error as { status?: number }).status === 1 ? 'systemd' : 'pidfile';
    }
  }
  return 'pidfile';
}

function unitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function run(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryRun(cmd: string, args: readonly string[]): string | undefined {
  try {
    return run(cmd, args);
  } catch {
    return undefined;
  }
}

function pidFile(paths: Paths): string {
  return join(paths.run, 'gateway.pid');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(paths: Paths): number | undefined {
  const file = pidFile(paths);
  const pid = existsSync(file) ? Number.parseInt(readFileSync(file, 'utf8'), 10) : Number.NaN;
  return Number.isInteger(pid) && pidAlive(pid) ? pid : undefined;
}

function startPidfile(paths: Paths): string {
  if (readPid(paths) !== undefined) {
    return 'already running';
  }
  mkdirSync(paths.run, { recursive: true });
  mkdirSync(paths.logs, { recursive: true });
  const out = openSync(join(paths.logs, 'gateway.log'), 'a');
  const [cmd, ...args] = gatewayCommand();
  const child = spawn(cmd ?? process.execPath, args, {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writeFileSync(pidFile(paths), String(child.pid));
  return `started (pid ${String(child.pid)})`;
}

function stopPidfile(paths: Paths): string {
  const pid = readPid(paths);
  rmSync(pidFile(paths), { force: true });
  if (pid === undefined) {
    return 'not running';
  }
  process.kill(pid, 'SIGTERM');
  return `stopped (pid ${String(pid)})`;
}

/** Write (or refresh) the unit/plist and start it. */
export function startService(manager: ServiceManager, paths: Paths): string {
  const command = gatewayCommand();
  mkdirSync(paths.logs, { recursive: true });
  if (manager === 'systemd') {
    mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unitPath(), systemdUnit(command, paths));
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    run('systemctl', ['--user', 'restart', SERVICE_NAME]);
    return `systemd user unit ${unitPath()} started`;
  }
  if (manager === 'launchd') {
    const domain = `gui/${String(userInfo().uid)}`;
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plistPath(), launchdPlist(command, paths));
    tryRun('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
    run('launchctl', ['bootstrap', domain, plistPath()]);
    return `launchd agent ${plistPath()} loaded`;
  }
  return startPidfile(paths);
}

export function stopService(manager: ServiceManager, paths: Paths): string {
  if (manager === 'systemd') {
    tryRun('systemctl', ['--user', 'stop', SERVICE_NAME]);
    return 'stopped';
  }
  if (manager === 'launchd') {
    tryRun('launchctl', ['bootout', `gui/${String(userInfo().uid)}/${LAUNCHD_LABEL}`]);
    return 'stopped';
  }
  return stopPidfile(paths);
}

/** Remove the unit/plist (after stopping). */
export function uninstallService(manager: ServiceManager, paths: Paths): string {
  stopService(manager, paths);
  if (manager === 'systemd') {
    tryRun('systemctl', ['--user', 'disable', SERVICE_NAME]);
    rmSync(unitPath(), { force: true });
    tryRun('systemctl', ['--user', 'daemon-reload']);
    return `removed ${unitPath()}`;
  }
  if (manager === 'launchd') {
    rmSync(plistPath(), { force: true });
    return `removed ${plistPath()}`;
  }
  return 'nothing to remove';
}

export function serviceState(manager: ServiceManager, paths: Paths): string {
  if (manager === 'systemd') {
    return tryRun('systemctl', ['--user', 'is-active', SERVICE_NAME]) ?? 'inactive';
  }
  if (manager === 'launchd') {
    const out = tryRun('launchctl', ['print', `gui/${String(userInfo().uid)}/${LAUNCHD_LABEL}`]);
    return out === undefined ? 'not loaded' : (/state = (\w+)/.exec(out)?.[1] ?? 'loaded');
  }
  const pid = readPid(paths);
  return pid === undefined ? 'not running' : `running (pid ${String(pid)})`;
}
