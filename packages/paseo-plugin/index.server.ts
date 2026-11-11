import type { PluginServerContext, PluginSettingsState } from '@getpaseo/plugin/server';

import { Background } from './server/background.ts';
import { readReportToken, type HookDeps } from './server/deps.ts';
import {
  downloadModel,
  engineLoad,
  listEngines,
  listPolicyThresholds,
  listPolicyVariants,
  policyPrompt,
  routingSettings,
  setRoutingPreset,
  reloadPolicies,
  discoverServers,
  saveConnection,
  selectEngine,
  setLifecycle,
  setPolicyMode,
  setPolicyThresholds,
  setPolicyVariant,
  setPath,
  validateEngine,
} from './server/engines.ts';
import { createOpenHandler } from './server/open.ts';
import { createPermissionHandlers } from './server/permission.ts';
import { preloadOnStart } from './server/preload.ts';
import { createRoutingHandler } from './server/routing.ts';
import { createStatusHandler, manualDecide, recordFeedback, statsText } from './server/rpc.ts';
import { defaultServiceEnv, runService, serviceInfo } from './server/service.ts';
import { createTurnHandler } from './server/turn.ts';
import { UsageLinks } from './server/usage.ts';
import { createGateway, type Gateway } from './shared/gateway.ts';
import {
  decideRpc,
  downloadModelRpc,
  engineLoadRpc,
  enginesRpc,
  feedbackRpc,
  lifecycleRpc,
  policyModeRpc,
  policyThresholdsRpc,
  policyVariantRpc,
  policyVariantsRpc,
  policyPromptRpc,
  routingPresetRpc,
  routingSettingsRpc,
  reloadPoliciesRpc,
  discoverServersRpc,
  saveConnectionRpc,
  selectEngineRpc,
  serviceInfoRpc,
  serviceRpc,
  setPathRpc,
  setPolicyThresholdsRpc,
  statsRpc,
  statusRpc,
  validateEngineRpc,
} from './shared/rpc.ts';
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
  const reportToken = readReportToken();
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
          gateway: createGateway({
            baseUrl: current.gatewayUrl,
            token: token(),
            reportToken,
          }),
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
  const preload = new AbortController();
  void preloadOnStart(deps, preload.signal).catch((error: unknown) => {
    log(`preload skipped: ${String(error)}`);
  });
  const onTurn = createTurnHandler(deps, { background });
  const permission = createPermissionHandlers(deps, background);
  const usage = new UsageLinks();
  const onCreate = createRoutingHandler(deps, undefined, usage);
  const onOpen = createOpenHandler(deps, token);

  server.addHook('agent.turn.after', async (event, ctx) => {
    void usage.turnEnded(deps, event, ctx.paseo);
    return onTurn(event, ctx);
  });
  server.addHook('agent.create.after', async ({ agent }) => usage.created(agent));
  server.addHook('agent.permission.before', async (event, ctx) => permission.before(event, ctx));
  server.addHook('agent.permission.after', async (event) => permission.after(event));
  server.addHook('agent.create.before', async (payload, ctx) => onCreate(payload, ctx));
  server.addHook('agent.open.before', async (payload) => onOpen(payload));

  const status = createStatusHandler(deps, undefined, markHealth);
  server.handle(statusRpc, async () => status());
  server.handle(statsRpc, async () => statsText(deps));
  server.handle(decideRpc, async (input, { paseo }) => manualDecide(deps, paseo, input));
  server.handle(feedbackRpc, async (input, { paseo }) => recordFeedback(deps, paseo, input));
  server.handle(enginesRpc, async () => listEngines(deps));
  server.handle(selectEngineRpc, async (input) => selectEngine(deps, input));
  server.handle(saveConnectionRpc, async (input) => saveConnection(deps, input));
  server.handle(discoverServersRpc, async (input) => discoverServers(deps, input));
  server.handle(downloadModelRpc, async (input) => downloadModel(deps, input));
  server.handle(validateEngineRpc, async ({ engine }) => validateEngine(deps, engine));
  server.handle(setPathRpc, async (input) => setPath(deps, input));
  server.handle(engineLoadRpc, async ({ action }) => engineLoad(deps, action));
  server.handle(lifecycleRpc, async (input) => setLifecycle(deps, input));
  server.handle(policyModeRpc, async (input) => setPolicyMode(deps, input));
  server.handle(policyVariantsRpc, async ({ policy }) => listPolicyVariants(deps, policy));
  server.handle(policyVariantRpc, async (input) => setPolicyVariant(deps, input));
  server.handle(policyThresholdsRpc, async ({ policy }) => listPolicyThresholds(deps, policy));
  server.handle(setPolicyThresholdsRpc, async (input) => setPolicyThresholds(deps, input));
  server.handle(reloadPoliciesRpc, async () => reloadPolicies(deps));
  server.handle(routingSettingsRpc, async () => routingSettings(deps));
  server.handle(routingPresetRpc, async (input) => setRoutingPreset(deps, input));
  server.handle(policyPromptRpc, async ({ policy }) => policyPrompt(deps, policy));
  server.handle(serviceInfoRpc, async () => serviceInfo(defaultServiceEnv()));
  server.handle(serviceRpc, async ({ action }) => {
    const res = await runService(defaultServiceEnv(), action);
    log(`service ${action}: ${res.ok ? 'ok' : (res.error ?? 'failed')}`);
    return res;
  });

  return () => {
    preload.abort();
    background.stop();
    cleanup();
  };
}
