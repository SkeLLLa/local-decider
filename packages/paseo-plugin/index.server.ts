import type { PluginServerContext, PluginSettingsState } from '@getpaseo/plugin/server';

import { Background } from './server/background.ts';
import type { HookDeps } from './server/deps.ts';
import { createMcpHandler } from './server/mcp.ts';
import { createPermissionHandlers } from './server/permission.ts';
import { createRoutingHandler } from './server/routing.ts';
import { createStatusHandler, gatewayModels, manualDecide, statsText } from './server/rpc.ts';
import { createTurnHandler } from './server/turn.ts';
import { createGateway, type Gateway } from './shared/gateway.ts';
import { decideRpc, gatewayModelsRpc, statsRpc, statusRpc } from './shared/rpc.ts';
import { deciderSettings, type DeciderSettings } from './shared/settings.ts';

const TOKEN_ENV = 'LOCAL_DECIDER_TOKEN';

function log(message: string): void {
  console.log(`[local-decider] ${message}`);
}

/** Bearer token for a remote gateway: daemon environment only, never settings, never logged. */
function token(): string | undefined {
  const value = process.env[TOKEN_ENV];
  return value === undefined || value === '' ? undefined : value;
}

/** A failed check is trusted for this long; afterwards hooks try the gateway again. */
const DOWN_TTL_MS = 60_000;

function createDeps(server: PluginServerContext): {
  deps: HookDeps;
  markHealth: (up: boolean) => void;
  cleanup: () => void;
} {
  const handle = server.registerSettings(deciderSettings);
  const defaults: DeciderSettings = deciderSettings.schema.parse({});
  let current = defaults;
  let cached: { url: string; gateway: Gateway | null } | null = null;
  let lastDownAt: number | null = null;

  const apply = (state: PluginSettingsState<typeof deciderSettings.schema>): void => {
    if (state.status === 'ready') {
      current = state.values;
    } else {
      current = defaults;
      log(`settings invalid, using defaults: ${state.error}`);
    }
  };
  // Hooks await the first read; later saves arrive through subscribe.
  const loaded = handle.read().then(apply, (error: unknown) => {
    log(`settings read failed, using defaults: ${String(error)}`);
  });
  const unsubscribe = handle.subscribe(apply);

  const deps: HookDeps = {
    async settings() {
      await loaded;
      return current;
    },
    async gateway() {
      await loaded;
      if (cached?.url !== current.gatewayUrl) {
        cached = {
          url: current.gatewayUrl,
          gateway: createGateway({ baseUrl: current.gatewayUrl, token: token() }),
        };
      }
      return cached.gateway;
    },
    log,
    gatewayKnownDown: () => lastDownAt !== null && Date.now() - lastDownAt < DOWN_TTL_MS,
  };
  return {
    deps,
    markHealth: (up) => {
      lastDownAt = up ? null : Date.now();
    },
    cleanup: () => {
      void unsubscribe();
    },
  };
}

export default function contribute(server: PluginServerContext): () => void {
  const { deps, markHealth, cleanup } = createDeps(server);

  const background = new Background();
  const onTurn = createTurnHandler(deps, { background });
  const permission = createPermissionHandlers(deps, background);
  const onCreate = createRoutingHandler(deps);
  const onOpen = createMcpHandler(deps, token);

  server.addHook('agent.turn.after', async (event, ctx) => onTurn(event, ctx));
  server.addHook('agent.permission.before', async (event, ctx) => permission.before(event, ctx));
  server.addHook('agent.permission.after', async (event) => permission.after(event));
  server.addHook('agent.create.before', async (payload, ctx) => onCreate(payload, ctx));
  server.addHook('agent.open.before', async (payload) => onOpen(payload));

  const status = createStatusHandler(deps, undefined, markHealth);
  server.handle(statusRpc, async () => status());
  server.handle(statsRpc, async () => statsText(deps));
  server.handle(gatewayModelsRpc, async () => gatewayModels(deps));
  server.handle(decideRpc, async (input, { paseo }) => manualDecide(deps, paseo, input));

  return () => {
    background.stop();
    cleanup();
  };
}
