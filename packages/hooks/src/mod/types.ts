/**
 * The slice of Claude Code's mod API (`$`, hook events) this mod uses. Claude Code generates the
 * full types into a plugin on `/plugin` use; these keep the mod typechecked without them.
 */

export interface ToolCheckEvent {
  readonly tool: string;
  readonly input: unknown;
  readonly tool_use_id?: string | undefined;
  /** Set when a subagent made the call. */
  readonly agentId?: string | undefined;
  readonly ceiling?: string | undefined;
}

export interface ToolCheckResult {
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly reason?: string | undefined;
  /** An ask rule decided. */
  readonly rule?: string | undefined;
  /** A PreToolUse hook forced the decision. */
  readonly hook?: string | undefined;
  /** A setting (such as `blockReadsOutsideWorkingDirectories`) decided. */
  readonly setting?: string | undefined;
  readonly decider?: string | undefined;
  readonly ceiling?: string | undefined;
}

/** What `next(e)` of `tool.call` resolves to: the tool result, or the text of a refusal. */
export interface ToolCallResult {
  readonly ref?: unknown;
  readonly result?: unknown;
  readonly text?: unknown;
  readonly isError?: unknown;
}

export interface Next<E, R> {
  (event: E): Promise<R>;
  readonly origin?: { readonly plugin?: string; readonly tier?: string } | undefined;
  readonly signal?: { readonly aborted: boolean } | undefined;
}

export interface SessionMessage {
  readonly role: string;
  readonly text?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

export interface ModApi {
  readonly session: {
    id(): Promise<string>;
    cwd(): Promise<string>;
    messages(): Promise<readonly SessionMessage[]>;
    version(): Promise<unknown>;
  };
  readonly env: { get(name: string): Promise<string | undefined> };
  readonly http: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<HttpResponse>;
  };
  readonly clock: { sleep(ms: number): Promise<void> };
}

export type ToolCheckHook = (
  $: ModApi,
  e: ToolCheckEvent,
  next: Next<ToolCheckEvent, ToolCheckResult>,
) => Promise<ToolCheckResult>;

export type ToolCallHook = (
  $: ModApi,
  e: ToolCheckEvent,
  next: Next<ToolCheckEvent, ToolCallResult>,
) => Promise<ToolCallResult>;

export interface Register {
  (event: 'tool.check', filter: { tool: readonly string[] }, hook: ToolCheckHook): void;
  (event: 'tool.call', filter: { tool: readonly string[] }, hook: ToolCallHook): void;
}
