import type { LogRecord } from '@ziptie-soft/local-decider-core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LogStore } from '../src/shadow.ts';
import { makeShadowRecord } from './records.ts';

type OpenStore = () => Promise<LogStore> | LogStore;

export function logStoreContract(name: string, open: OpenStore): void {
  describe(`${name} LogStore contract`, () => {
    it('appends and reads decisions, verified outcomes and usage', async () => {
      const log = await open();
      try {
        const decision = makeShadowRecord('contract-decision');
        const outcome: LogRecord = {
          kind: 'outcome',
          ts: decision.ts,
          decisionId: decision.decisionId,
          outcome: 'allow',
          source: 'user',
          verified: true,
        };
        const usage: LogRecord = {
          kind: 'usage',
          ts: decision.ts,
          decisionId: decision.decisionId,
          turnId: 'turn-1',
          model: 'provider/model',
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 3,
          costUsd: 0.01,
        };
        for (const record of [decision, outcome, usage]) {
          log.append(record);
        }
        assert.deepEqual(log.read(), [decision, outcome, usage]);
      } finally {
        close(log);
      }
    });

    it('filters recent records by the UTC day boundary and prunes old records', async () => {
      const log = await open();
      try {
        log.append(makeShadowRecord('old', { ts: '2026-08-12T10:00:00.000Z' }));
        log.append(makeShadowRecord('boundary', { ts: '2026-08-13T10:00:00.000Z' }));
        log.append(makeShadowRecord('recent', { ts: '2026-11-10T10:00:00.000Z' }));
        assert.deepEqual(
          log.readRecent(2, Date.parse('2026-11-11T00:00:00.000Z')).map((r) => r.decisionId),
          ['recent'],
        );
        assert.equal(log.prune(90, Date.parse('2026-11-11T00:00:00.000Z')), 1);
        assert.deepEqual(
          log.read().map((r) => r.decisionId),
          ['boundary', 'recent'],
        );
      } finally {
        close(log);
      }
    });
  });
}

function close(log: LogStore): void {
  const closable = log as LogStore & { close?: () => void };
  closable.close?.();
}
