import type { SystemOneRequest, SystemOneResponse } from '@local-decider/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, type GatewayConfig } from '../src/config.ts';
import type { HostCapabilities } from '../src/engines/host-capabilities.ts';
import type { Engine, EngineHealth, EngineState } from '../src/engines/types.ts';
import type { Paths } from '../src/paths.ts';

export function tempPaths(): Paths {
  const data = mkdtempSync(join(tmpdir(), 'ld-test-'));
  return {
    data,
    config: join(data, 'config'),
    logs: join(data, 'logs'),
    venvs: join(data, 'venvs'),
    engines: join(data, 'engines'),
    run: join(data, 'run'),
  };
}

export function testConfig(overrides: Record<string, unknown> = {}): GatewayConfig {
  return parseConfig({ port: 0, ...overrides });
}

type Responder = (
  request: SystemOneRequest,
  signal: AbortSignal,
) => Promise<SystemOneResponse> | SystemOneResponse;

/** Scripted engine: answers every choice question with `probs` (or a custom responder). */
export class FakeEngine implements Engine {
  readonly id = 'fake';
  readonly model = 'fake-model';
  state: EngineState = 'ready';
  readonly requests: SystemOneRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  respond: Responder;

  constructor(probs: Record<string, number> = {}) {
    this.respond = (request) => choiceResponse(request, probs);
  }

  async start(): Promise<void> {}

  health(): EngineHealth {
    return { state: this.state, model: this.model };
  }

  async decide(request: SystemOneRequest, signal: AbortSignal): Promise<SystemOneResponse> {
    this.requests.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      return await this.respond(request, signal);
    } finally {
      this.inFlight -= 1;
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopped';
  }
}

function choiceResponse(
  request: SystemOneRequest,
  probs: Record<string, number>,
): SystemOneResponse {
  const answers: Record<string, SystemOneResponse['answers'][string]> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type === 'choice') {
      const options = Object.keys(q.criteria);
      const p = Object.fromEntries(options.map((o) => [o, probs[o] ?? 0]));
      const choice = options.reduce((a, b) => ((p[b] ?? 0) > (p[a] ?? 0) ? b : a));
      answers[id] = { type: 'choice', choice, probabilities: p };
    }
  }
  return { model: 'fake-model', answers };
}

/** A fixed accelerator probe result for tests: nothing found, so no real probe runs. */
export const NO_CAPABILITIES: HostCapabilities = {
  npu: { status: 'unavailable', evidence: 'stub' },
  nvidia: { status: 'unavailable', evidence: 'stub' },
  apple: { status: 'unavailable', evidence: 'stub' },
  vulkan: { status: 'unavailable', evidence: 'stub' },
  probedAt: 0,
};

export const stubCapabilities = (): Promise<HostCapabilities> => Promise.resolve(NO_CAPABILITIES);
