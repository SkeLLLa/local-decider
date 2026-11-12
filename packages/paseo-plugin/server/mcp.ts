/** The gateway's MCP server (`<gatewayUrl>/mcp`, streamable HTTP), injected by `open.ts`. */
import type { Gateway } from '../shared/gateway.ts';
import { loopbackUrl, originOf } from '../shared/url.ts';
import type { HookDeps } from './deps.ts';

export interface McpServerConfig {
  type: 'http';
  url: string;
}

/** Never carries headers: the daemon's tokens must not reach agent processes (S5). */
export function mcpServerConfig(baseUrl: string): McpServerConfig {
  return { type: 'http', url: `${baseUrl}/mcp` };
}

/** Why the gateway's MCP cannot be injected without handing the agent a credential, or null. */
function injectionBlocker(gateway: Gateway): string | null {
  if (!loopbackUrl(gateway.baseUrl))
    return `${originOf(gateway.baseUrl) ?? 'the gateway'} is not loopback`;
  return gateway.bearer ? 'the gateway needs a bearer token, which agents must not hold' : null;
}

/** The server to inject, or null when injection is off, no gateway is configured, or it needs a credential. */
export async function gatewayMcpServer(deps: HookDeps): Promise<McpServerConfig | null> {
  const settings = await deps.settings();
  const gateway = settings.injectMcp ? await deps.gateway() : null;
  if (gateway === null) return null;
  const blocker = injectionBlocker(gateway);
  if (blocker !== null) {
    deps.log(`mcp injection skipped: ${blocker}`);
    return null;
  }
  return mcpServerConfig(gateway.baseUrl);
}
