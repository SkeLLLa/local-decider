import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import type { Paths } from './paths.ts';

const SERVICE_NAME = 'local-decider';
const LAUNCHD_LABEL = 'dev.local-decider.gateway';

/** The argv that runs `gateway run` with the same node and flags as this process. */
function gatewayCommand(): string[] {
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

/** Variables copied from the CLI's environment into the agent. Never a token. */
const LAUNCHD_PASSTHROUGH = [
  'LOCAL_DECIDER_HOME',
  'LOCAL_DECIDER_CONFIG_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'HF_HOME',
  'HF_HUB_CACHE',
] as const;

/**
 * The environment of the launchd agent, which starts with a bare PATH: node's and uv's
 * directories first, then the usual tool locations. No tokens; those go in `<config>/env`.
 */
export function launchdEnv(
  env: NodeJS.ProcessEnv,
  execPath: string,
  tools: { readonly uv?: string | undefined },
): Record<string, string> {
  const home = env['HOME'] ?? homedir();
  const dirs = [
    dirname(execPath),
    ...(tools.uv === undefined ? [] : [dirname(tools.uv)]),
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const out: Record<string, string> = { PATH: [...new Set(dirs)].join(':'), HOME: home };
  for (const key of LAUNCHD_PASSTHROUGH) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

/** Node loads `<config>/env` (tokens) if present: launchd's `EnvironmentFile=-`. */
function launchdCommand(command: readonly string[], paths: Paths): string[] {
  const [node = process.execPath, ...rest] = command;
  return [node, `--env-file-if-exists=${join(paths.config, 'env')}`, ...rest];
}

function plistEnv(env: Readonly<Record<string, string>>): string {
  const rows = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n');
  return `  <key>EnvironmentVariables</key>\n  <dict>\n${rows}\n  </dict>\n`;
}

export function launchdPlist(
  command: readonly string[],
  paths: Paths,
  env: Readonly<Record<string, string>> = {},
): string {
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
${plistEnv(env)}  <key>RunAtLoad</key>
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

/** Write `content` to `file` only if it differs; true when it changed. */
function writeIfChanged(file: string, content: string): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) {
    return false;
  }
  writeFileSync(file, content);
  return true;
}

function startSystemd(command: readonly string[], paths: Paths, restart: boolean): string {
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  const changed = writeIfChanged(unitPath(), systemdUnit(command, paths));
  if (changed) {
    run('systemctl', ['--user', 'daemon-reload']);
  }
  const active = tryRun('systemctl', ['--user', 'is-active', SERVICE_NAME]) === 'active';
  run('systemctl', ['--user', 'enable', SERVICE_NAME]);
  if (active && !changed && !restart) {
    return `already running (${unitPath()} unchanged); use \`gateway restart\` to reload`;
  }
  run('systemctl', ['--user', active ? 'restart' : 'start', SERVICE_NAME]);
  return `systemd user unit ${unitPath()} ${active ? 'restarted' : 'started'}`;
}

/** What `startLaunchd` needs from launchctl; injected so tests never touch the real one. */
export interface LaunchctlDeps {
  readonly run: (args: readonly string[]) => string;
  readonly tryRun: (args: readonly string[]) => string | undefined;
  readonly sleep: (ms: number) => void;
  readonly uid: number;
  /** Where the plist lives; defaults to `~/Library/LaunchAgents`. */
  readonly plist?: string;
}

const defaultLaunchctl: LaunchctlDeps = {
  run: (args) => run('launchctl', args),
  tryRun: (args) => tryRun('launchctl', args),
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  uid: userInfo().uid,
};

const UNLOAD_POLLS = 50;
const UNLOAD_STEP_MS = 100;
const BOOTSTRAP_TRIES = 4;
const BOOTSTRAP_RETRY_MS = 500;

function waitUnloaded(target: string, deps: LaunchctlDeps): boolean {
  for (let i = 0; i < UNLOAD_POLLS; i += 1) {
    if (deps.tryRun(['print', target]) === undefined) {
      return true;
    }
    deps.sleep(UNLOAD_STEP_MS);
  }
  return deps.tryRun(['print', target]) === undefined;
}

function isBusy(error: unknown): boolean {
  const e = error as { status?: number; message?: string; stderr?: string };
  return e.status === 5 || /Input\/output error/.test(`${e.message ?? ''}${e.stderr ?? ''}`);
}

/** `bootstrap`, retried while launchd still tears the previous job down (exit 5, EIO). */
function bootstrap(domain: string, plist: string, deps: LaunchctlDeps): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      deps.run(['bootstrap', domain, plist]);
      return;
    } catch (error) {
      if (!isBusy(error) || attempt >= BOOTSTRAP_TRIES) {
        const why = error instanceof Error ? error.message : String(error);
        throw new Error(`launchctl bootstrap failed after ${String(attempt)} attempt(s): ${why}`, {
          cause: error,
        });
      }
      deps.sleep(BOOTSTRAP_RETRY_MS);
    }
  }
}

export function startLaunchd(
  command: readonly string[],
  paths: Paths,
  restart: boolean,
  deps: LaunchctlDeps = defaultLaunchctl,
  env: Readonly<Record<string, string>> = launchdEnv(process.env, process.execPath, {
    uv: tryRun('which', ['uv']),
  }),
): string {
  const domain = `gui/${String(deps.uid)}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const plist = deps.plist ?? plistPath();
  mkdirSync(dirname(plist), { recursive: true });
  const changed = writeIfChanged(plist, launchdPlist(launchdCommand(command, paths), paths, env));
  const loaded = deps.tryRun(['print', target]) !== undefined;
  if (loaded && !changed) {
    if (!restart) {
      return `already loaded (${plist} unchanged); use \`gateway restart\` to reload`;
    }
    deps.run(['kickstart', '-k', target]);
    return `launchd agent ${plist} restarted`;
  }
  if (loaded) {
    deps.tryRun(['bootout', target]);
    if (!waitUnloaded(target, deps)) {
      throw new Error(`launchd did not unload ${LAUNCHD_LABEL} within 5s`);
    }
  }
  bootstrap(domain, plist, deps);
  return `launchd agent ${plist} loaded`;
}

/**
 * Write (or refresh) the unit/plist and make sure it runs. Idempotent: a running service with an
 * unchanged unit is left alone, because every restart reloads the model and drops decisions
 * meanwhile. `restart` forces one (e.g. after rebuilding the gateway).
 */
export function startService(manager: ServiceManager, paths: Paths, restart = false): string {
  const command = gatewayCommand();
  mkdirSync(paths.logs, { recursive: true });
  if (manager === 'systemd') {
    return startSystemd(command, paths, restart);
  }
  if (manager === 'launchd') {
    return startLaunchd(command, paths, restart);
  }
  if (restart) {
    stopPidfile(paths);
  }
  return startPidfile(paths);
}

export function stopService(manager: ServiceManager, paths: Paths): string {
  if (manager === 'systemd') {
    tryRun('systemctl', ['--user', 'stop', SERVICE_NAME]);
    return 'stopped';
  }
  if (manager === 'launchd') {
    const target = `gui/${String(defaultLaunchctl.uid)}/${LAUNCHD_LABEL}`;
    defaultLaunchctl.tryRun(['bootout', target]);
    waitUnloaded(target, defaultLaunchctl);
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
