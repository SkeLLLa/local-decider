import type { AgentPermissionRequest, AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPermissionInput,
  buildRoutingInput,
  buildTurnInput,
  head,
  LIMITS,
  mergeAssistantChunks,
  tail,
  turnItems,
} from '../server/history.ts';

const user = (text: string): AgentTimelineItem => ({ type: 'user_message', text });
const assistant = (text: string, messageId?: string): AgentTimelineItem =>
  messageId === undefined
    ? { type: 'assistant_message', text }
    : { type: 'assistant_message', text, messageId };
const tool = (name: string): AgentTimelineItem => ({
  type: 'tool_call',
  callId: name,
  name,
  status: 'completed',
  error: null,
  detail: { type: 'unknown', input: null, output: null },
});

describe('head/tail', () => {
  it('bound text from the right side', () => {
    assert.equal(head('abcdef', 4), 'abc…');
    assert.equal(tail('abcdef', 4), '…def');
    assert.equal(head('abc', 4), 'abc');
  });
});

describe('mergeAssistantChunks', () => {
  it('joins consecutive chunks of one message', () => {
    const merged = mergeAssistantChunks([
      user('hi'),
      assistant('Hel', 'm1'),
      assistant('lo', 'm1'),
      tool('Read'),
      assistant('Bye', 'm2'),
    ]);
    assert.deepEqual(
      merged.map((i) => ('text' in i ? i.text : i.type)),
      ['hi', 'Hello', 'tool_call', 'Bye'],
    );
  });

  it('keeps different message ids apart', () => {
    assert.equal(mergeAssistantChunks([assistant('a', 'm1'), assistant('b', 'm2')]).length, 2);
  });
});

describe('turnItems', () => {
  it('prefers entries tagged with the turn id', () => {
    const entries = [
      { item: user('old'), turnId: 't1' },
      { item: user('new'), turnId: 't2' },
      { item: assistant('done'), turnId: 't2' },
    ];
    assert.deepEqual(
      turnItems(entries, 't2').map((i) => ('text' in i ? i.text : '')),
      ['new', 'done'],
    );
  });

  it('falls back to everything after the last user message', () => {
    const entries = [
      { item: user('a') },
      { item: assistant('x') },
      { item: user('b') },
      { item: assistant('y') },
    ];
    assert.deepEqual(
      turnItems(entries, null).map((i) => ('text' in i ? i.text : '')),
      ['b', 'y'],
    );
  });
});

describe('buildTurnInput', () => {
  it('builds task, transcript and the final message, most recent last', () => {
    const input = buildTurnInput(
      [
        { item: user('Fix the failing test'), turnId: 't' },
        { item: tool('Bash'), turnId: 't' },
        { item: assistant('All ', 'm'), turnId: 't' },
        { item: assistant('green.', 'm'), turnId: 't' },
      ],
      't',
    );
    assert.deepEqual(input, {
      task: 'Fix the failing test',
      history: 'user: Fix the failing test\ntool Bash (completed)\nassistant: All green.',
      lastMessage: 'All green.',
    });
  });

  it('uses an error as the final message and the previous prompt as the task', () => {
    const input = buildTurnInput(
      [{ item: user('Do it') }, { item: { type: 'error', message: 'rate limited' }, turnId: 't' }],
      't',
    );
    assert.equal(input?.task, 'Do it');
    assert.equal(input?.lastMessage, 'error: rate limited');
  });

  it('is null without assistant output', () => {
    assert.equal(buildTurnInput([{ item: user('hello') }], null), null);
  });

  it('bounds every field', () => {
    const long = 'x'.repeat(50_000);
    const entries = Array.from({ length: 40 }, () => ({ item: assistant(long) }));
    const input = buildTurnInput([{ item: user(long) }, ...entries], null);
    assert.ok(input !== null);
    assert.ok(input.task.length <= LIMITS.task);
    assert.ok(input.history.length <= LIMITS.history);
    assert.ok(input.lastMessage.length <= LIMITS.lastMessage);
  });

  it('skips reasoning and plugin rows in the transcript', () => {
    const input = buildTurnInput(
      [
        { item: user('q') },
        { item: { type: 'reasoning', text: 'secret thoughts' } },
        { item: { type: 'plugin', id: 'p', pluginId: 'x', kind: 'k', version: 1, data: null } },
        { item: assistant('a') },
      ],
      null,
    );
    assert.equal(input?.history, 'user: q\nassistant: a');
  });
});

describe('buildPermissionInput', () => {
  it('renders the request as bounded JSON with tool and project', () => {
    const request: AgentPermissionRequest = {
      id: 'r1',
      provider: 'claude',
      name: 'Bash',
      kind: 'tool',
      title: 'Run ls',
      input: { command: 'ls -la' },
    };
    const input = buildPermissionInput('/home/u/project', 'user: list files', request);
    assert.equal(input.project, '/home/u/project');
    assert.equal(input.tool, 'Bash · tool · Run ls');
    assert.deepEqual(JSON.parse(input.request), { title: 'Run ls', input: { command: 'ls -la' } });
    assert.equal(input.history, 'user: list files');
  });
});

describe('buildRoutingInput', () => {
  it('uses the title as the prompt and is null without one', () => {
    assert.deepEqual(buildRoutingInput('/p', ' Rename foo '), {
      project: '/p',
      prompt: 'Rename foo',
    });
    assert.equal(buildRoutingInput('/p', null), null);
    assert.equal(buildRoutingInput('/p', '  '), null);
  });
});
