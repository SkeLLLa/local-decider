/** Queries and settings shared by the plugin's screens, sidebar items and timeline rows. */
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { z } from 'zod';

import { nextPollDelay } from '../shared/poll.ts';
import { gatewayModelsRpc, statusRpc } from '../shared/rpc.ts';
import { deciderSettings, type DeciderSettings } from '../shared/settings.ts';

export type Status = z.output<typeof statusRpc.output>;
export type Catalog = z.output<typeof gatewayModelsRpc.output>;

const STATUS_QUERY_KEY = ['local-decider', 'status'] as const;
const DEFAULTS: DeciderSettings = deciderSettings.schema.parse({});

/**
 * Shared, polled gateway status: 15 s while up, backing off to 2 min while down. `enabled: false`
 * for an observer that is not on screen.
 */
export function useGatewayStatus(enabled = true): UseQueryResult<Status> {
  const status = useRpc(statusRpc);
  return useQuery({
    queryKey: STATUS_QUERY_KEY,
    enabled,
    queryFn: async () => status({}),
    retry: false,
    staleTime: 5000,
    refetchInterval: (query) =>
      nextPollDelay(query.state.data?.downStreak ?? query.state.fetchFailureCount),
  });
}

/** `GET /models` through the daemon: what the gateway serves and can switch to. */
export function useGatewayCatalog(gatewayUrl: string): UseQueryResult<Catalog> {
  const models = useRpc(gatewayModelsRpc);
  return useQuery({
    queryKey: ['local-decider', 'gateway-models', gatewayUrl],
    queryFn: async () => models({}),
    retry: false,
    staleTime: 15_000,
  });
}

/** Saved settings for read-only consumers: null while loading, defaults when unreadable. */
export function useDeciderValues(): DeciderSettings | null {
  const settings = useSettings(deciderSettings);
  if (settings.status === 'loading') {
    return null;
  }
  return settings.status === 'ready' ? settings.values : DEFAULTS;
}
