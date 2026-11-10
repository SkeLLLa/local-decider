/**
 * Deterministic guard: a short, conservative list of shell commands that are destructive enough
 * to deny without asking a model. It runs before any gateway call and never allows anything; a
 * miss simply falls through to the `command-risk` policy.
 */
import { baseName, commandWords, splitShell, type Segment } from './shell.ts';

export interface GuardHit {
  readonly rule: string;
  readonly reason: string;
}

const SYSTEM_DIRS = [
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'lib',
  'lib32',
  'lib64',
  'opt',
  'proc',
  'root',
  'sbin',
  'srv',
  'sys',
  'usr',
  'var',
  'Applications',
  'Library',
  'System',
  'Users',
  'private',
];
/** `/`, `/*`, `~`, `$HOME` and top-level system directories, with an optional `/` or `/*`. */
const DANGEROUS_TARGET = new RegExp(
  `^(?:/|/\\*|(?:~|\\$HOME|\\$\\{HOME\\})(?:/|/\\*)?|/(?:${SYSTEM_DIRS.join('|')})(?:/|/\\*)?)$`,
);
/** A `.git` directory: `.git`, `./.git/`, `repo/.git`. */
const GIT_DIR = /(?:^|\/)\.git\/?$/;
const DISK = String.raw`/dev/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|disk\d)`;
const DISK_DEVICE = new RegExp(`^${DISK}`);
const DISK_REDIRECT = new RegExp(`^\\d?>>?${DISK}`);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
const SHELL_SUBST_FETCH = /\b(?:ba|z|da|k)?sh\b[^;&|]*(?:<\(|\$\()\s*(?:curl|wget)\b/;
const FORK_BOMB = /([A-Za-z_:][\w:]*)\(\)\{\1\|\1&\};\1/;

function flags(args: readonly string[]): readonly string[] {
  return args.filter((a) => a.startsWith('-'));
}

function operands(args: readonly string[]): readonly string[] {
  return args.filter((a) => !a.startsWith('-'));
}

function isRecursive(args: readonly string[]): boolean {
  return flags(args).some((f) => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f));
}

function checkRm(args: readonly string[]): GuardHit | null {
  if (!isRecursive(args)) {
    return null;
  }
  const targets = operands(args);
  if (targets.some((t) => DANGEROUS_TARGET.test(t))) {
    return {
      rule: 'rm-root',
      reason: 'recursive delete of the filesystem root, home or a system directory',
    };
  }
  if (targets.some((t) => GIT_DIR.test(t))) {
    return { rule: 'rm-git', reason: 'deletes a .git directory (the repository history)' };
  }
  return null;
}

function checkChmod(args: readonly string[]): GuardHit | null {
  const ops = operands(args);
  const worldWritable = ops.some((o) => /^(?:0?777|(?:a|ugo)\+rwx)$/.test(o));
  if (isRecursive(args) && worldWritable && ops.some((t) => DANGEROUS_TARGET.test(t))) {
    return {
      rule: 'chmod-777-root',
      reason: 'recursive chmod 777 on the root or a system directory',
    };
  }
  return null;
}

function checkDd(args: readonly string[]): GuardHit | null {
  if (args.some((a) => a.startsWith('of=') && DISK_DEVICE.test(a.slice(3)))) {
    return { rule: 'dd-disk', reason: 'dd writes straight to a disk device' };
  }
  return null;
}

const FORCE = /^(?:-f|--force|--force-with-lease(?:=.*)?|-[A-Za-z]*f[A-Za-z]*)$/;
const PROTECTED_REF = /(?:^|:|\+)(?:refs\/heads\/)?(?:main|master)$/;

function checkGit(args: readonly string[]): GuardHit | null {
  const push = args.indexOf('push');
  if (push === -1) {
    return null;
  }
  const rest = args.slice(push + 1);
  const forced = rest.some((a) => FORCE.test(a)) || rest.some((a) => /^\+./.test(a));
  if (forced && rest.some((a) => PROTECTED_REF.test(a))) {
    return { rule: 'git-force-push-main', reason: 'force-push to main or master' };
  }
  return null;
}

function checkPower(cmd: string, args: readonly string[]): GuardHit | null {
  const systemctl = cmd === 'systemctl' && args.some((a) => POWER.has(a));
  const init = (cmd === 'init' || cmd === 'telinit') && (args[0] === '0' || args[0] === '6');
  if (POWER.has(cmd) || systemctl || init) {
    return { rule: 'shutdown', reason: 'shuts down or reboots the machine' };
  }
  return null;
}

function checkRedirects(words: readonly string[]): GuardHit | null {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? '';
    const next = words[i + 1] ?? '';
    if (DISK_REDIRECT.test(w) || (/^\d?>>?$/.test(w) && DISK_DEVICE.test(next))) {
      return { rule: 'redirect-disk', reason: 'redirects output onto a disk device' };
    }
  }
  return null;
}

/** `bash -c "…"`: check the inline script too. */
function checkInlineShell(cmd: string, args: readonly string[]): GuardHit | null {
  const c = args.indexOf('-c');
  const script = c === -1 ? undefined : args[c + 1];
  return SHELLS.has(cmd) && script !== undefined ? guardCommand(script) : null;
}

function checkWords(words: readonly string[]): GuardHit | null {
  const [first = '', ...args] = commandWords(words);
  const cmd = baseName(first);
  if (cmd === 'rm') {
    return checkRm(args);
  }
  if (cmd.startsWith('mkfs')) {
    return { rule: 'mkfs', reason: 'formats a filesystem' };
  }
  const checks: Record<string, (a: readonly string[]) => GuardHit | null> = {
    chmod: checkChmod,
    dd: checkDd,
    git: checkGit,
  };
  return (
    checks[cmd]?.(args) ??
    checkPower(cmd, args) ??
    checkInlineShell(cmd, args) ??
    checkRedirects(words)
  );
}

function isFetch(segment: Segment | undefined): boolean {
  const cmd = baseName(commandWords(segment?.words ?? [])[0] ?? '');
  return cmd === 'curl' || cmd === 'wget';
}

function checkPipeToShell(segments: readonly Segment[]): GuardHit | null {
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const cmd = baseName(commandWords(seg?.words ?? [])[0] ?? '');
    if (seg?.piped === true && SHELLS.has(cmd) && isFetch(segments[i - 1])) {
      return { rule: 'curl-pipe-shell', reason: 'pipes a downloaded script into a shell' };
    }
  }
  return null;
}

function checkRaw(command: string): GuardHit | null {
  if (FORK_BOMB.test(command.replace(/\s+/g, ''))) {
    return { rule: 'fork-bomb', reason: 'fork bomb' };
  }
  if (SHELL_SUBST_FETCH.test(command)) {
    return { rule: 'curl-pipe-shell', reason: 'runs a downloaded script in a shell' };
  }
  return null;
}

/** Return the first deterministic rule a shell command hits, or `null`. */
export function guardCommand(command: string): GuardHit | null {
  const raw = checkRaw(command);
  if (raw !== null) {
    return raw;
  }
  const segments = splitShell(command);
  for (const segment of segments) {
    const hit = checkWords(segment.words);
    if (hit !== null) {
      return hit;
    }
  }
  return checkPipeToShell(segments);
}
