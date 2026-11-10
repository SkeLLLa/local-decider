/** `routing.presets` in config.yaml: what `route:<preset>` means for each harness. */
import type { DecideRequest, DecideResponse, RouteTarget } from '@local-decider/core';

import type { GatewayConfig } from './config.ts';

const ROUTE_PREFIX = 'route:';

type Targets = NonNullable<GatewayConfig['routing']['presets'][DecideRequest['harness']]>;

function targetsOf(config: GatewayConfig, harness: DecideRequest['harness']): Targets {
  return config.routing.presets[harness] ?? {};
}

/** The preset target for `action` in `harness`, or undefined when unmapped or not a route. */
function routeOf(
  config: GatewayConfig,
  harness: DecideRequest['harness'],
  action: string,
): RouteTarget | undefined {
  if (!action.startsWith(ROUTE_PREFIX)) {
    return undefined;
  }
  const preset = action.slice(ROUTE_PREFIX.length);
  const targets = targetsOf(config, harness);
  const target = Object.hasOwn(targets, preset) ? targets[preset] : undefined;
  return target === undefined
    ? undefined
    : { preset, model: target.model, ...(target.mode === undefined ? {} : { mode: target.mode }) };
}

/** Give a request without its own `models.routes` the configured ones, for savings stats. */
export function withConfiguredRoutes(config: GatewayConfig, request: DecideRequest): DecideRequest {
  if (request.models?.routes !== undefined) {
    return request;
  }
  const entries = Object.entries(targetsOf(config, request.harness));
  if (entries.length === 0) {
    return request;
  }
  const routes = Object.fromEntries(
    entries.map(([preset, t]) => [`${ROUTE_PREFIX}${preset}`, t.model]),
  );
  return { ...request, models: { ...request.models, routes } };
}

/** Attach the harness's target for a routing action. */
export function withRoute(
  config: GatewayConfig,
  harness: DecideRequest['harness'],
  response: DecideResponse,
): DecideResponse {
  const route = routeOf(config, harness, response.action);
  return route === undefined ? response : { ...response, route };
}
