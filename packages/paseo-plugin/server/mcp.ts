/** The gateway's MCP server (`<gatewayUrl>/mcp`, streamable HTTP), injected by `open.ts`. */
import { tokenAllowed } from '../shared/url.ts';
import type { HookDeps } from './deps.ts';

export interface McpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export function mcpServerConfig(baseUrl: string, token: string | undefined): McpServerConfig {
  const url = `${baseUrl}/mcp`;
  return token === undefined || token === '' || !tokenAllowed(url)
    ? { type: 'http', url }
    : { type: 'http', url, headers: { authorization: `Bearer ${token}` } };
}

/** The server to inject, or `null` when injection is off or no gateway is configured. */
export async function gatewayMcpServer(
  deps: HookDeps,
  token: () => string | undefined,
): Promise<McpServerConfig | null> {
  const settings = await deps.settings();
  const gateway = settings.injectMcp ? await deps.gateway() : null;
  return gateway === null ? null : mcpServerConfig(gateway.baseUrl, token());
}
