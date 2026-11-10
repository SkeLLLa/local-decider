/** Queries and settings shared by the plugin's screens, sidebar items and timeline rows. */
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';

import { enginesPollInterval, type EngineCatalog } from '../shared/engines.ts';
import { nextPollDelay } from '../shared/poll.ts';
import { enginesRpc, serviceInfoRpc, statusRpc } from '../shared/rpc.ts';
import { deciderSettings, type DeciderSettings } from '../shared/settings.ts';

export type Status = z.output<typeof statusRpc.output>;
export type ServiceInfo = z.output<typeof serviceInfoRpc.output>;

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

/**
 * `GET /v1/engines` through the daemon. Polls every 2.5 s while a download runs or a model
 * loads, only while a screen that uses it is mounted, and stops once nothing is running.
 */
export function useEngines(gatewayUrl: string): UseQueryResult<EngineCatalog> {
  const engines = useRpc(enginesRpc);
  return useQuery({
    queryKey: ['local-decider', 'engines', gatewayUrl],
    queryFn: async () => engines({}),
    retry: false,
    staleTime: 10_000,
    refetchInterval: (query) => enginesPollInterval(query.state.data),
  });
}

/** Whether the gateway runs as a user service here, and the command behind each button. */
export function useServiceInfo(): UseQueryResult<ServiceInfo> {
  const info = useRpc(serviceInfoRpc);
  return useQuery({
    queryKey: ['local-decider', 'service-info'],
    queryFn: async () => info({}),
    retry: false,
    staleTime: 60_000,
  });
}

export interface Outcome {
  readonly tone: 'error' | 'success';
  readonly text: string;
}

/**
 * Run one gateway action at a time and keep its outcome for an inline message. `busy` names the
 * running action; every query of the plugin is refreshed afterwards.
 */
export function useAction(): {
  busy: string | null;
  outcome: Outcome | null;
  run: (name: string, task: () => Promise<Outcome>) => Promise<Outcome>;
  clear: () => void;
} {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const run = async (name: string, task: () => Promise<Outcome>): Promise<Outcome> => {
    setBusy(name);
    setOutcome(null);
    let result: Outcome;
    try {
      result = await task();
    } catch (error) {
      result = { tone: 'error', text: error instanceof Error ? error.message : String(error) };
    }
    setOutcome(result);
    setBusy(null);
    await queryClient.invalidateQueries({ queryKey: ['local-decider'] });
    return result;
  };
  return { busy, outcome, run, clear: () => setOutcome(null) };
}

/** An RPC result `{ok, error}` as an outcome. */
export function outcomeOf(res: { ok: boolean; error: string | null }, success: string): Outcome {
  return res.ok
    ? { tone: 'success', text: success }
    : { tone: 'error', text: res.error ?? 'The gateway refused without a reason.' };
}

/** Saved settings for read-only consumers: null while loading, defaults when unreadable. */
export function useDeciderValues(): DeciderSettings | null {
  const settings = useSettings(deciderSettings);
  if (settings.status === 'loading') {
    return null;
  }
  return settings.status === 'ready' ? settings.values : DEFAULTS;
}
