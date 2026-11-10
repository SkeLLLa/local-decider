/**
 * Cheap, bounded transcript reading. Claude Code and Codex both write JSONL transcripts; the hook
 * reads only a fixed-size head (for the task) and tail (for recent history), never the whole file.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import type { Turn } from './turns.ts';

export interface TranscriptSlice {
  /** First bytes of the file; lines past the cut are dropped. */
  readonly head: string;
  /** Last bytes of the file; the first, partial line is dropped. */
  readonly tail: string;
}

const SLICE_BYTES = 16 * 1024;

function readAt(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n).toString('utf8');
}

/** Read the head and tail of a file, `bytes` each. `null` when it can't be read. */
export function readSlice(path: string, bytes: number = SLICE_BYTES): TranscriptSlice | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const head = readAt(fd, 0, Math.min(bytes, size));
    if (size <= bytes) {
      return { head, tail: head };
    }
    const tail = readAt(fd, size - bytes, bytes);
    return {
      head: head.slice(0, head.lastIndexOf('\n') + 1),
      tail: tail.slice(tail.indexOf('\n') + 1),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Text blocks only: tool calls, tool results and thinking are skipped. */
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(isRecord)
    .filter(
      (b) => b['type'] === 'text' || b['type'] === 'input_text' || b['type'] === 'output_text',
    )
    .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
    .join('\n');
}

/** Claude: `{type, message: {role, content}}`; Codex: `{type: 'response_item', payload: {type: 'message', role, content}}`. */
function messageOf(entry: Record<string, unknown>): Record<string, unknown> | null {
  if (entry['isMeta'] === true || entry['isSidechain'] === true) {
    return null;
  }
  const payload = entry['type'] === 'response_item' ? entry['payload'] : entry['message'];
  return isRecord(payload) ? payload : null;
}

/** Injected context (system reminders, environment blocks, AGENTS.md) is not conversation. */
function isInjected(text: string): boolean {
  return text.startsWith('<') || text.startsWith('# AGENTS.md');
}

function parseLine(line: string): Turn | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = isRecord(entry) ? messageOf(entry) : null;
  const role = msg?.['role'];
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }
  const text = contentText(msg?.['content']).trim();
  return text === '' || isInjected(text) ? null : { role, text };
}

export function parseTurns(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split('\n')) {
    const turn = line.trim() === '' ? null : parseLine(line);
    if (turn !== null) {
      turns.push(turn);
    }
  }
  return turns;
}
