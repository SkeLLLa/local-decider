/**
 * `agent.open.before` → optionally inject the gateway's MCP server (`<gatewayUrl>/mcp`, streamable
 * HTTP). Launch-only. Never awaits a write to the agent being opened (that would deadlock).
 */
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';

import { MCP_SERVER_NAME } from '../shared/constants.ts';
import { tokenAllowed } from '../shared/url.ts';
import { errorText, type HookDeps } from './deps.ts';

export function mcpServerConfig(
  baseUrl: string,
  token: string | undefined,
): { type: 'http'; url: string; headers?: Record<string, string> } {
  const url = `${baseUrl}/mcp`;
  return token === undefined || token === '' || !tokenAllowed(url)
    ? { type: 'http', url }
    : { type: 'http', url, headers: { authorization: `Bearer ${token}` } };
}

export function createMcpHandler(
  deps: HookDeps,
  token: () => string | undefined,
): (payload: {
  request: PluginSessionOpenRequest;
}) => Promise<PluginSessionOpenRequest | undefined> {
  return async ({ request }) => {
    try {
      if (request.purpose === 'history') {
        return undefined;
      }
      const settings = await deps.settings();
      const gateway = settings.injectMcp ? await deps.gateway() : null;
      if (gateway === null) {
        return undefined;
      }
      return {
        ...request,
        mcpServers: {
          ...request.mcpServers,
          [MCP_SERVER_NAME]: mcpServerConfig(gateway.baseUrl, token()),
        },
      };
    } catch (error) {
      deps.log(`mcp injection skipped: ${errorText(error)}`);
      return undefined;
    }
  };
}
