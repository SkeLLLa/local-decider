# ADR-0001: Node/TypeScript gateway supervising Python engines

Status: accepted (2026-11-10)

## Context

Every harness adapter is JavaScript: Paseo plugins are TypeScript bundled by Paseo, and Claude
Code and Codex hooks need a runtime that is already on the user's PATH, which is Node for both.
The reference engine (strands-decider) is Python with torch; other engines are not
(llama.cpp server, Ollama, laya-serve over HTTP, Laya and GLiClass through onnxruntime-node).

## Decision

The gateway is Node/TypeScript and shares `@local-decider/core` (types, policy schema, client)
with the adapters. Python engines run as child processes from a uv-managed venv under
`~/.local/share/local-decider/venvs/<engine>`, synced from a pinned uv project shipped in the
gateway package.

## Consequences

- Users without a Python engine (remote, llama.cpp, Ollama) never need Python.
- One source of truth for the wire contract and policy schema; no cross-language drift.
- The gateway supervises a process it did not write: start-up waits on the engine's `/health`
  (model load plus warmup can take minutes on CPU), and crashes are restarted with backoff.
- A Python FastAPI gateway would have saved one hop (about 1 ms on loopback) but split the
  schema across two languages and forced Python on every user.
