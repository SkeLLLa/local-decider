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
  if (target === undefined) {
    return undefined;
  }
  const { model, mode, thinking, profile } = target;
  return {
    preset,
    ...(model === undefined ? {} : { model }),
    ...(mode === undefined ? {} : { mode }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(profile === undefined ? {} : { profile }),
  };
}

/** Give a request without its own `models.routes` the configured ones, for savings stats. */
export function withConfiguredRoutes(config: GatewayConfig, request: DecideRequest): DecideRequest {
  if (request.models?.routes !== undefined) {
    return request;
  }
  // A profile-only target names no model here; the harness can send that route itself.
  const entries = Object.entries(targetsOf(config, request.harness)).flatMap(([preset, t]) =>
    t.model === undefined ? [] : [[`${ROUTE_PREFIX}${preset}`, t.model] as const],
  );
  if (entries.length === 0) {
    return request;
  }
  const routes = Object.fromEntries(entries);
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
