import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { gatewaySource } from '../server/gateway-source.ts';
import type { GatewayOptions } from '../shared/gateway.ts';
import { fakeGateway, tempDir } from './fakes.ts';

const report = 'R'.repeat(43);
const control = 'C'.repeat(43);

describe('gatewaySource', () => {
  it('re-reads missing and malformed token files and caches by URL and credentials', () => {
    const dir = tempDir('gateway-source');
    const env: NodeJS.ProcessEnv = { LOCAL_DECIDER_CONFIG_DIR: dir };
    const builds: GatewayOptions[] = [];
    const source = gatewaySource({
      env,
      log: () => {},
      create: (options) => {
        builds.push(options ?? {});
        return fakeGateway(() => null);
      },
    });
    const first = source('http://127.0.0.1:8765');
    const firstBuild = builds[0];
    assert.ok(firstBuild !== undefined);
    assert.equal(firstBuild.reportToken, undefined);
    assert.equal(firstBuild.controlToken, undefined);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'control-token'), 'truncated');
    assert.equal(source('http://127.0.0.1:8765'), first);
    assert.equal(builds.length, 1);
    writeFileSync(join(dir, 'report-token'), report);
    writeFileSync(join(dir, 'control-token'), control);
    const rebuilt = source('http://127.0.0.1:8765');
    assert.notEqual(rebuilt, first);
    assert.equal(builds[1]?.reportToken, report);
    assert.equal(builds[1]?.controlToken, control);
    assert.equal(source('http://127.0.0.1:8765'), rebuilt);
    assert.equal(builds.length, 2);
  });

  it('re-reads local tokens after a 401 invalidates the cached gateway', () => {
    const dir = tempDir('gateway-source');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report-token'), report);
    writeFileSync(join(dir, 'control-token'), control);
    const builds: GatewayOptions[] = [];
    const source = gatewaySource({
      env: { LOCAL_DECIDER_CONFIG_DIR: dir },
      log: () => {},
      create: (options) => {
        builds.push(options ?? {});
        return fakeGateway(() => null);
      },
    });
    source('http://127.0.0.1:8765');
    const firstBuild = builds[0];
    assert.ok(firstBuild !== undefined);
    firstBuild.onUnauthorised?.();
    const rotated = 'N'.repeat(43);
    writeFileSync(join(dir, 'control-token'), rotated);
    source('http://127.0.0.1:8765');
    assert.equal(builds.length, 2);
    assert.equal(builds[1]?.controlToken, rotated);
  });

  it('logs once per validated origin when a bearer is withheld', () => {
    const logs: string[] = [];
    const builds: GatewayOptions[] = [];
    const env: NodeJS.ProcessEnv = { LOCAL_DECIDER_TOKEN: 'BEARER_SECRET' };
    const source = gatewaySource({
      env,
      log: (message) => logs.push(message),
      create: (options) => {
        builds.push(options ?? {});
        return fakeGateway(() => null);
      },
    });
    source('https://gw.example/secret-path');
    source('https://gw.example/secret-path');
    const firstBuild = builds[0];
    assert.ok(firstBuild !== undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /LOCAL_DECIDER_TOKEN_ORIGIN/);
    assert.match(logs[0] ?? '', /https:\/\/gw\.example/);
    assert.equal(logs[0]?.includes('BEARER_SECRET'), false);
    assert.equal(logs[0]?.includes('/secret-path'), false);
    assert.equal(firstBuild.token, 'BEARER_SECRET');
  });

  it('explains that a remote gateway must use https before setting an origin pin', () => {
    const logs: string[] = [];
    const source = gatewaySource({
      env: { LOCAL_DECIDER_TOKEN: 'BEARER_SECRET' },
      log: (message) => logs.push(message),
      create: () => fakeGateway(() => null),
    });
    source('http://gw.example');
    assert.deepEqual(logs, [
      'bearer withheld from http://gw.example: a remote gateway must use https',
    ]);
  });
});
