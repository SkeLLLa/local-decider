/**
 * `agent.open.before`: tell the harness hooks inside the agent which policies this plugin runs,
 * and optionally inject the gateway's MCP server. Launch-only. Never awaits a write to the agent
 * being opened (that would deadlock).
 */
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';

import { HOOK_POLICIES, HOST_POLICIES_ENV, MCP_SERVER_NAME } from '../shared/constants.ts';
import { errorText, type HookDeps } from './deps.ts';
import { gatewayMcpServer } from './mcp.ts';

/**
 * `env` with this plugin's policies added to `LOCAL_DECIDER_HOST_POLICIES`. All of them, whatever
 * their mode: Paseo settings govern Paseo agents, so `off` here means off, not "let hooks do it".
 */
export function hostEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const listed = (env[HOST_POLICIES_ENV] ?? '').split(',').map((p) => p.trim());
  const policies = new Set([...listed.filter((p) => p !== ''), ...HOOK_POLICIES]);
  return { ...env, [HOST_POLICIES_ENV]: [...policies].join(',') };
}

async function mcpServers(
  deps: HookDeps,
  request: PluginSessionOpenRequest,
): Promise<PluginSessionOpenRequest['mcpServers']> {
  try {
    const server = await gatewayMcpServer(deps);
    return server === null
      ? request.mcpServers
      : { ...request.mcpServers, [MCP_SERVER_NAME]: server };
  } catch (error) {
    deps.log(`mcp injection skipped: ${errorText(error)}`);
    return request.mcpServers;
  }
}

export function createOpenHandler(
  deps: HookDeps,
): (payload: {
  request: PluginSessionOpenRequest;
}) => Promise<PluginSessionOpenRequest | undefined> {
  return async ({ request }) => {
    if (request.purpose === 'history') {
      return undefined;
    }
    return {
      ...request,
      env: hostEnv(request.env),
      mcpServers: await mcpServers(deps, request),
    };
  };
}
