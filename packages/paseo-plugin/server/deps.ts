/**
 * What hook and RPC handlers need from the daemon side, as narrow structural types so tests can
 * pass plain fakes. `PaseoApi` satisfies `PaseoLike`.
 */
import type {
  AgentPermissionResponse,
  AgentRuntimeInfo,
  AgentTimelineItem,
  AgentUsage,
  JsonValue,
} from '@getpaseo/protocol/agent-types';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Gateway } from '../shared/gateway.ts';
import type { DeciderSettings } from '../shared/settings.ts';

export interface AppendItem {
  type: 'plugin';
  id: string;
  kind: string;
  version: number;
  data: JsonValue;
}

export interface AgentRefLike {
  readonly timeline: {
    refetch(options: { direction: 'tail'; limit: number }): Promise<{
      readonly entries: readonly {
        readonly item: AgentTimelineItem;
        readonly turnId?: string | undefined;
      }[];
    }>;
    append(item: AppendItem): Promise<unknown>;
  };
  respondToPermission(options: {
    requestId: string;
    response: AgentPermissionResponse;
  }): Promise<void>;
  /** Fetch a fresh snapshot, which fills `lastUsage` and `runtimeInfo`. Absent in some fakes. */
  refresh?(): Promise<unknown>;
  readonly lastUsage?: AgentUsage | null;
  readonly runtimeInfo?: Pick<AgentRuntimeInfo, 'provider' | 'model'> | null;
}

export interface PaseoLike {
  readonly agents: { ref(agentId: string): AgentRefLike };
}

export interface HookDeps {
  settings(): Promise<DeciderSettings>;
  /** null when the configured URL is unusable. */
  gateway(): Promise<Gateway | null>;
  log(message: string): void;
  /** True when a recent health check failed; waiting hooks then skip the gateway entirely. */
  gatewayKnownDown?(): boolean;
}

/** Read a local token using the gateway's config directory precedence. */
export function readLocalToken(
  name: 'report-token' | 'control-token',
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const config =
    env['LOCAL_DECIDER_CONFIG_DIR'] ??
    join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'local-decider');
  try {
    const token = readFileSync(join(config, name), 'utf8').trim();
    // Same format as the gateway's `isLocalToken`.
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Read the server-only outcome token. */
export function readReportToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readLocalToken('report-token', env);
}

/** Read the server-only control token. */
export function readControlToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readLocalToken('control-token', env);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
