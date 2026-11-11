# Plan: set up OpenAI-compatible and LM Studio engines from the UI

Status: proposed (architect review, 2026-11-11). Trigger: the Paseo engine card says "Not
installed. set engines.openai-compatible.url/model", gives no way to enter it, and LM Studio on
`127.0.0.1:1234` was not discovered.

## Decisions

- A connection form for `openai-compatible` and `lmstudio`: **API base URL**, **Model**
  (discovered options plus free text), **Token environment variable (optional)**. Separate
  **Find models**, **Save** and **Use**. Discovery never selects an engine.
- `POST /v1/config/engine` in `settings-routes.ts` accepts only `{engine, url, model, tokenEnv}`
  for those two engines. A blank or omitted `tokenEnv` removes the setting.
- Validation: HTTP(S) URL, at most 2,048 characters, no credentials, query or fragment, trailing
  slashes normalized. Model ids are 1–300 characters with no whitespace or leading `-`. Token
  variable names match `^[A-Z_][A-Z0-9_]*$`. Unknown fields are rejected without echoing their
  values.
- Persist through `ConfigFile.update`, which keeps comments and unrelated options. Edit
  `engine.*` when its type matches the engine, otherwise `engines.<id>.*`. Precedence stays as it
  is: the matching primary `engine` block beats `engines`, and `selection` picks the active
  engine and model. No separate UI store.
- Editing the active engine rebuilds it once through the serialized switch queue. **Save** keeps
  the current selection. **Use** saves, then calls the existing `/v1/engine`.
- Only the environment-variable name is accepted, stored and returned. The raw token is never
  accepted, resolved, stored, logged or sent. Discovery without the token may fail, so typing a
  model by hand always works.
- Local suggestions run only when the connection settings open or on **Find local servers**:
  fixed `127.0.0.1` ports 1234 (LM Studio), 11434 (Ollama) and 8080 (llama.cpp), `/v1/models`.
  LM Studio is identified by its native models response, never by port alone.
- Probes do no scanning, DNS, redirects, credentials, inference or process execution. Results and
  model ids are untrusted data.
- Budget: three concurrent probes, a 1 s overall deadline, 256 KiB response cap, bounded model
  counts, 30 s positive and negative cache, in-flight deduplication. Nothing probes inside
  decisions or catalog requests. `EngineControl.status()` reads cached discovery and refreshes
  outside that path.
- Setup and discovery go through the trusted settings RPC behind the gateway's Host, Origin and
  auth guards, with the local-only `pathsEditable` restriction. The gateway stays on `127.0.0.1`.
- LM Studio copy: "LM Studio found at `http://127.0.0.1:1234/v1`. Choose LM Studio for its chat and
  logprob defaults. OpenAI-compatible remains available for custom settings." Offer **Set up LM
  Studio**, keeping the chosen URL. Never switch engines silently. Both engines stay uncalibrated.

## Slices

| Slice | Goal | Anchors | Acceptance |
|---|---|---|---|
| S1 Connection settings | Configure either engine without editing YAML | `settings-routes.ts` `ROUTES`; `engine-control.ts` `describeSettings`, `#engineConfig`, `#applySelectionConfig`; `config-file.ts` `ConfigFile.update`; `engines/openai/index.ts` `sharedShape` | Invalid or secret-bearing payloads leave disk unchanged. Save and restart round trips work. Primary and per-engine blocks both update. Active edits rebuild once. Inactive saves don't switch engines |
| S2 Bounded discovery | Find models before a model is configured | `engine-discovery.ts` `discoveryEndpoint`, `ModelDiscovery`; `engine-control.ts` `status`, `#discoverAll`; `engines/http.ts` `requestJson`; `POST /v1/engines/discover` (empty body = suggestions, `{engine,url}` = models from that URL, never persists) | An unconfigured LM Studio yields a suggestion and models. Stopped, malformed, oversized and redirecting servers finish within budget. Catalog and decision calls launch no probes. A changed URL never reuses another endpoint's models |
| S3 Paseo, CLI, docs | Replace the dead-end message with setup | `paseo-plugin/client/settings-engines.tsx` `EnginePicker`, `engineHint`; `shared/engines.ts`; `shared/rpc.ts`; `server/engines.ts`; `engine-control.ts` `#openAIDetails`; `cli-settings.ts`, `cli.ts`; `docs/install.md`, `docs/engines.md`, `docs/security.md` | Copy: "Not configured. Enter your server's API base URL and choose or type a model below. Nothing to install." The picker says "Not configured", not "Not installed". CLI `local-decider engine configure <engine> --url --model [--token-env]` works with the gateway down. URL-only discovery, manual entry, clearing the token variable, save errors, activation and older gateways all work. Nothing is labelled "connected" without evidence |
