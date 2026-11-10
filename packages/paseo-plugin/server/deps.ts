/**
 * What hook and RPC handlers need from the daemon side, as narrow structural types so tests can
 * pass plain fakes. `PaseoApi` satisfies `PaseoLike`.
 */
import type {
  AgentPermissionResponse,
  AgentTimelineItem,
  JsonValue,
} from '@getpaseo/protocol/agent-types';

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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
