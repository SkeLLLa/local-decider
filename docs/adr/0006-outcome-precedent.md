# ADR-0006: Exact-match outcome precedent

Status: accepted (2026-11-10)

## Decision

- A policy may name a harness input key as its precedent subject. Adapters normalize that subject;
  the gateway redacts it, combines it with the policy id and project, and stores only the SHA-256
  key. Policy version is excluded so labels survive wording changes.
- Only escalated (`ask`) decisions can collect labels. The first outcome for each decision id is
  final; only `allow` and `deny` outcomes from policy-approved sources count, and any deny vetoes
  precedent.
- Precedent may lower an allow threshold only when the current model answer still selects allow
  with p(allow) ≥ 0.6 and the exact subject has at least the configured number of allows and no
  denies. It never bypasses the model.
- The gateway rebuilds recent evidence from the existing JSONL decision log at startup. In-memory
  keys use a 10,000-entry LRU bound; no separate precedent database is created.

## Consequences

Precedent is project-scoped, exact-match, and auditable from decision and outcome records. It
learns only after a human or supervised parent answers an escalated request; labels do not carry
over to similar commands or other projects.
