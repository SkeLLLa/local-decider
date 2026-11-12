/** Queries and settings shared by the plugin's screens, sidebar items and timeline rows. */
import { useRpc, useSettings } from '@getpaseo/plugin/client';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';

import {
  BENCHMARK_POLL_MS,
  benchmarkPollInterval,
  type BenchmarkView,
} from '../shared/benchmark.ts';
import { enginesPollInterval, type EngineCatalog } from '../shared/engines.ts';
import { nextPollDelay } from '../shared/poll.ts';
import { benchmarkRpc, enginesRpc, serviceInfoRpc, statusRpc } from '../shared/rpc.ts';
import { deciderSettings, type DeciderSettings } from '../shared/settings.ts';
import { useQueryKey } from './host-scope.ts';

export type Status = z.output<typeof statusRpc.output>;
export type ServiceInfo = z.output<typeof serviceInfoRpc.output>;

const DEFAULTS: DeciderSettings = deciderSettings.schema.parse({});

/**
 * Shared, polled gateway status: 15 s while up, backing off to 2 min while down. `enabled: false`
 * for an observer that is not on screen.
 */
export function useGatewayStatus(enabled = true): UseQueryResult<Status> {
  const status = useRpc(statusRpc);
  return useQuery({
    queryKey: useQueryKey('status'),
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
    queryKey: useQueryKey('engines', gatewayUrl),
    queryFn: async () => engines({}),
    retry: false,
    staleTime: 10_000,
    refetchInterval: (query) => enginesPollInterval(query.state.data),
  });
}

/**
 * The benchmark job (`GET /v1/benchmark`). Polls every second while it runs or is cancelling, and
 * also while `watch` is set (the catalog says another client started one). When a job leaves
 * running/cancelling the engines query is refreshed, because new results and a restored
 * selection land then.
 */
export function useBenchmark(
  gatewayUrl: string,
  watch = false,
): UseQueryResult<BenchmarkView | null> {
  const benchmark = useRpc(benchmarkRpc);
  const queryClient = useQueryClient();
  const enginesKey = useQueryKey('engines', gatewayUrl);
  const query = useQuery({
    queryKey: useQueryKey('benchmark', gatewayUrl),
    queryFn: async () => (await benchmark({})).benchmark,
    retry: false,
    staleTime: 0,
    refetchInterval: (q) =>
      benchmarkPollInterval(q.state.data) || (watch ? BENCHMARK_POLL_MS : false),
  });
  const wasRunning = useRef(false);
  const running = benchmarkPollInterval(query.data) !== false;
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: enginesKey });
    }
    wasRunning.current = running;
  }, [running, queryClient, enginesKey]);
  return query;
}

/** Whether the gateway runs as a user service here, and the command behind each button. */
export function useServiceInfo(): UseQueryResult<ServiceInfo> {
  const info = useRpc(serviceInfoRpc);
  return useQuery({
    queryKey: useQueryKey('service-info'),
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
  const hostKey = useQueryKey();
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
    await queryClient.invalidateQueries({ queryKey: hostKey });
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
