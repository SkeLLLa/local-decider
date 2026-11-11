import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { DecideRequest, DecideResponse } from '@ziptie-soft/local-decider-core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

import type { Decider } from './decider.ts';

/** What the MCP tools need: the in-process decider, or a client of a running gateway. */
export interface McpBackend {
  decide(policy: string, request: DecideRequest, signal: AbortSignal): Promise<DecideResponse>;
  listPolicies(): Promise<unknown>;
}

export function deciderBackend(decider: Decider): McpBackend {
  return {
    decide: (policy, request, signal) => decider.decide(policy, request, signal),
    listPolicies: async () =>
      [...decider.policies.values()].map(({ policy, mode }) => ({
        id: policy.id,
        description: policy.description,
        mode,
        inputKeys: policy.state.sections.map((s) => s.from),
      })),
  };
}

const VERSION = '1.0.0'; // x-release-please-version

function toolResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** One MCP server exposing `decide` (run a policy) and `policies` (list them). */
export function createMcpServer(backend: McpBackend): McpServer {
  const server = new McpServer({ name: 'local-decider', version: VERSION });
  server.registerTool(
    'decide',
    {
      title: 'Local decision model',
      description:
        'Ask the local decision model a fixed-choice question through a policy. Returns the action, ' +
        'per-option probabilities and a calibrated confidence. Fast and local; no free text.',
      inputSchema: {
        policy: z
          .string()
          .describe('Policy id, e.g. turn-outcome, permission, routing, command-risk'),
        input: z
          .record(z.string(), z.unknown())
          .describe(
            "Structured input; keys follow the policy's state sections (see the policies tool)",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ policy, input }, extra) => {
      const decision = await backend.decide(policy, { harness: 'mcp', input }, extra.signal);
      return toolResult(decision);
    },
  );
  server.registerTool(
    'policies',
    {
      title: 'List decision policies',
      description: 'List loaded policies with their mode and the input keys each expects.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(await backend.listPolicies()),
  );
  return server;
}

/** Stateless streamable HTTP: a fresh server and transport per request. */
export async function handleMcpHttp(
  decider: Decider,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createMcpServer(deciderBackend(decider));
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true }); // no sessionIdGenerator = stateless;
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function serveMcpStdio(backend: McpBackend): Promise<void> {
  await createMcpServer(backend).connect(new StdioServerTransport());
}
