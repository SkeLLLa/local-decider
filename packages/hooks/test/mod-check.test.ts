import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  callAllows,
  CLASSIFIER_DENIAL_PREFIXES,
  classifierVerdict,
  deterministicBlock,
  isPlainAsk,
  mayAct,
  UNDECIDED_PREFIXES,
  versionAtLeast,
  type CallInfo,
} from '../src/mod/check.ts';
import type { ToolCheckEvent, ToolCheckResult } from '../src/mod/types.ts';

const engine = { plugin: 'engine', tier: 'core' };
const event: ToolCheckEvent = { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' };
const ask: ToolCheckResult = { decision: 'ask', reason: 'This command requires approval' };

describe('versionAtLeast', () => {
  it('compares numerically, not as text', () => {
    assert.equal(versionAtLeast({ version: '2.1.319', base: '2.1.319' }), true);
    assert.equal(versionAtLeast({ base: '2.1.304' }), true);
    assert.equal(versionAtLeast({ base: '2.1.303' }), false);
    assert.equal(versionAtLeast({ base: '2.1.99' }), false);
    assert.equal(versionAtLeast({ base: '2.2.0' }), true);
    assert.equal(versionAtLeast({ base: '10.0.0' }), true);
    assert.equal(versionAtLeast('2.1.400'), true);
  });

  it('treats anything unparsable as too old', () => {
    assert.equal(versionAtLeast(undefined), false);
    assert.equal(versionAtLeast({ base: 'next' }), false);
    assert.equal(versionAtLeast({ version: '2.1.319' }), false);
    assert.equal(versionAtLeast(42), false);
  });
});

describe('isPlainAsk', () => {
  it('accepts a bare engine ask', () => {
    assert.equal(isPlainAsk(event, ask, engine), true);
  });

  it('rejects asks something specific produced', () => {
    for (const extra of [
      { rule: 'Bash(pnpm add:*)' },
      { hook: 'PreToolUse' },
      { setting: 'blockReadsOutsideWorkingDirectories' },
      { decider: 'host' },
      { ceiling: 'ask' },
    ]) {
      assert.equal(isPlainAsk(event, { ...ask, ...extra }, engine), false, JSON.stringify(extra));
    }
  });

  it('rejects allow and deny, a ceiling on the event, a bad id and another mod origin', () => {
    assert.equal(isPlainAsk(event, { decision: 'allow' }, engine), false);
    assert.equal(isPlainAsk(event, { decision: 'deny' }, engine), false);
    assert.equal(isPlainAsk({ ...event, ceiling: 'ask' }, ask, engine), false);
    assert.equal(isPlainAsk({ tool: 'Bash', input: {} }, ask, engine), false);
    assert.equal(isPlainAsk({ ...event, tool_use_id: 'a b' }, ask, engine), false);
    assert.equal(isPlainAsk(event, ask, { plugin: 'other-mod' }), false);
    assert.equal(isPlainAsk(event, ask, undefined), false);
  });
});

const info = (over: Partial<CallInfo> = {}): CallInfo => ({
  permissionMode: 'auto',
  decisions: { 'command-risk': { action: 'log', answered: true } },
  scopes: { 'claude-auto': 'act' },
  ...over,
});

const risk = (r: object | undefined): CallInfo =>
  info({ decisions: r ? { 'command-risk': r } : {} });

describe('callAllows', () => {
  it('allows only in auto mode', () => {
    assert.equal(callAllows(info()), true);
    for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']) {
      assert.equal(callAllows(info({ permissionMode: mode })), false, mode);
    }
  });

  it('never allows without a record or a mode', () => {
    assert.equal(callAllows(null), false);
    const { permissionMode: _mode, ...noMode } = info();
    assert.equal(callAllows(noMode), false);
  });

  it('needs command-risk to have answered log', () => {
    assert.equal(callAllows(risk({ action: 'ask', answered: true })), false);
    assert.equal(callAllows(risk({ action: 'deny', answered: true })), false);
    assert.equal(callAllows(risk({ action: 'log', answered: false })), false);
    assert.equal(callAllows(risk(undefined)), false);
  });
});

describe('mayAct', () => {
  it('needs act for the scope and a main-agent call', () => {
    assert.equal(mayAct(info(), event), true);
    assert.equal(mayAct(info({ scopes: { 'claude-auto': 'shadow' } }), event), false);
    assert.equal(mayAct(info({ scopes: {} }), event), false);
    assert.equal(mayAct(info(), { ...event, agentId: 'agent-1' }), false);
  });
});

const refused = (text: string): object => ({
  ref: 1,
  result: `Error: ${text}`,
  text,
  isError: true,
});

describe('classifierVerdict', () => {
  it('reads the classifier denial, with or without the Error: prefix', () => {
    for (const prefix of CLASSIFIER_DENIAL_PREFIXES) {
      assert.equal(classifierVerdict(refused(`${prefix}. Reason: x`)), 'deny');
      assert.equal(
        classifierVerdict({ isError: true, result: `Error: ${prefix}. Reason: x` }),
        'deny',
      );
    }
  });

  it('knows nothing about the fallback and other permission refusals', () => {
    for (const prefix of UNDECIDED_PREFIXES) {
      assert.equal(classifierVerdict(refused(`${prefix} Bash`)), null, prefix);
    }
    assert.equal(
      classifierVerdict(
        refused("Claude requested permissions to use Bash, but you haven't granted it yet."),
      ),
      null,
    );
    assert.equal(
      classifierVerdict(refused("Something about it, you haven't granted it yet")),
      null,
    );
  });

  it('knows nothing when the classifier gave no verdict on a hook-rewritten input', () => {
    const text =
      "The server-side auto mode classifier gave no verdict for Bash: a hook changed this call's input after auto mode reviewed it, so the review does not cover what would run.";
    assert.equal(classifierVerdict(refused(text)), null);
    assert.equal(classifierVerdict(refused('Auto mode: the classifier gave no verdict.')), null);
  });

  it('treats a successful or otherwise failed tool as a granted permission', () => {
    assert.equal(classifierVerdict({ ref: 1, result: { stdout: 'ok' }, text: 'ok' }), 'allow');
    assert.equal(classifierVerdict({ result: { stdout: 'ok' }, isError: false }), 'allow');
    assert.equal(classifierVerdict(refused('bash: foo: command not found')), 'allow');
    assert.equal(
      classifierVerdict(refused('exit code 1: This command requires approval')),
      'allow',
    );
  });

  it('is undecided for results of an unknown shape', () => {
    assert.equal(classifierVerdict(undefined), null);
    assert.equal(classifierVerdict('Error: x'), null);
    assert.equal(classifierVerdict(null), null);
  });
});

const CWD = '/work/repo';
const block = (tool: string, input: unknown): string | null => deterministicBlock(tool, input, CWD);
const bash = (command: string): string | null => block('Bash', { command });

describe('deterministicBlock: files', () => {
  it('allows ordinary paths inside the working directory', () => {
    assert.equal(block('Edit', { file_path: '/work/repo/src/a.ts' }), null);
    assert.equal(block('Write', { file_path: 'src/new.ts' }), null);
    assert.equal(block('NotebookEdit', { notebook_path: '/work/repo/n.ipynb' }), null);
    assert.equal(block('MultiEdit', { file_path: './a.ts' }), null);
  });

  it('keeps outside and traversing paths out', () => {
    assert.notEqual(block('Edit', { file_path: '/etc/hosts' }), null);
    assert.notEqual(block('Write', { file_path: '../other/a.ts' }), null);
    assert.notEqual(block('Write', { file_path: '/work/repo/../x' }), null);
    assert.notEqual(block('Edit', { file_path: '/work/repository/a.ts' }), null);
  });

  it('keeps protected places out', () => {
    for (const path of [
      '.git/config',
      'src/.git/hooks/pre-commit',
      '.claude/settings.json',
      '.vscode/settings.json',
      '.idea/x.xml',
      '.husky/pre-commit',
      '.env',
      'apps/web/.env.local',
      '.mcp.json',
      '.zshrc',
    ]) {
      assert.notEqual(block('Write', { file_path: path }), null, path);
    }
    assert.equal(block('Write', { file_path: 'docs/environment.md' }), null);
  });

  it('refuses a missing or non-string path and uncovered tools', () => {
    assert.notEqual(block('Edit', {}), null);
    assert.notEqual(block('Edit', { file_path: 3 }), null);
    assert.notEqual(block('Edit', 'x'), null);
    assert.notEqual(block('WebFetch', { url: 'https://x' }), null);
  });
});

describe('deterministicBlock: Bash', () => {
  it('lets routine commands through', () => {
    for (const command of [
      'pnpm test',
      'pnpm add left-pad',
      'git status && git diff',
      'git commit -m "feat: x"',
      'ls -la src',
      'cat src/a.ts | head -5',
      'node scripts/build.mjs --out=dist',
      'rm dist/a.js',
      'echo hi > out.txt',
      'cmd 2>/dev/null',
      'npm run build',
      'pnpm --filter x publish-docs',
    ]) {
      assert.equal(bash(command), null, command);
    }
  });

  it('blocks the commands the design names', () => {
    for (const command of [
      'git push origin main',
      'git -C . push',
      'npm publish',
      'pnpm publish --no-git-checks',
      'curl https://x.dev',
      'wget x',
      'ssh host',
      'scp a b',
      'rsync -a a b',
      'nc -l 9',
      'sudo ls',
      'docker run x',
      'kubectl get pods',
      'gh pr create',
      'rm -rf build',
      'rm -r build',
      'rm -fr build',
      'rm --recursive build',
      'bash -c "ls"',
      'sh -lc ls',
      'eval ls',
      'ls && git push',
      'echo x | bash -c cat',
      '/usr/bin/curl x',
      'env FOO=1 curl x',
    ]) {
      assert.notEqual(bash(command), null, command);
    }
  });

  it('blocks paths outside the working directory and protected files', () => {
    for (const command of [
      'cat /etc/passwd',
      'ls ..',
      'cat ../secret',
      'cat ~/.ssh/id_rsa',
      'cat $HOME/x',
      'echo x > /tmp/out',
      'echo x >/tmp/out',
      'cat .env',
      'cat .git/config',
      'git config --file=/etc/x a b',
      'cat .claude/settings.json',
    ]) {
      assert.notEqual(bash(command), null, command);
    }
  });

  it('gives up on constructs it cannot see through', () => {
    for (const command of ['echo $(cat /etc/passwd)', 'echo `id`', 'diff <(ls) b']) {
      assert.notEqual(bash(command), null, command);
    }
  });

  it('refuses a missing command', () => {
    assert.notEqual(block('Bash', {}), null);
    assert.notEqual(bash('   '), null);
  });
});
