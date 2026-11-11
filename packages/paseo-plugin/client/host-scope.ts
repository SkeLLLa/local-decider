/**
 * The Paseo client shares one react-query cache across hosts, so every query key carries the id of
 * the host its RPC goes to. Each contribution entry component is wrapped with `withHostScope`,
 * which reads `props.host.id` and provides it to `useQueryKey`.
 */
import type { PluginHostProps } from '@getpaseo/plugin/client';
import {
  createContext,
  createElement,
  useContext,
  type ComponentType,
  type ReactNode,
} from 'react';

export const DEFAULT_HOST_ID = 'default';
const ROOT = 'local-decider';

export type QueryKey = readonly [typeof ROOT, string, ...unknown[]];

/** `['local-decider', hostId, ...parts]`; with no parts, the prefix of every key of that host. */
export function hostQueryKey(hostId: string, ...parts: readonly unknown[]): QueryKey {
  return [ROOT, hostId, ...parts];
}

const HostScope = createContext<string>(DEFAULT_HOST_ID);

/** The host id of the surrounding contribution, or `default` when rendered outside a scope. */
export function useHostId(): string {
  return useContext(HostScope);
}

/** Query key scoped to this host. */
export function useQueryKey(...parts: readonly unknown[]): QueryKey {
  return hostQueryKey(useHostId(), ...parts);
}

const wrapped = new WeakMap<object, unknown>();

/** Provide `props.host.id` to the component tree below it. Stable per component identity. */
export function withHostScope<P extends PluginHostProps>(
  Component: ComponentType<P>,
): ComponentType<P> {
  const cached = wrapped.get(Component);
  if (cached !== undefined) {
    return cached as ComponentType<P>;
  }
  const Scoped = (props: P): ReactNode =>
    createElement(
      HostScope.Provider,
      { value: props.host?.id ?? DEFAULT_HOST_ID },
      createElement(Component, props),
    );
  Scoped.displayName = `HostScope(${Component.displayName ?? Component.name})`;
  wrapped.set(Component, Scoped);
  return Scoped;
}
