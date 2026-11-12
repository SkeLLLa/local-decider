# ADR-0006: Exact-match outcome precedent

Status: accepted (2026-11-10)

Storage details are superseded in part by [ADR-0010](0010-sqlite-decision-store.md).

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

## Addendum (2026-11-11): verified outcomes

Only outcomes authenticated with the gateway's private report token may update precedent or
calibration hints. Unauthenticated outcomes are logged as `source: unverified` and
`verified: false`; they remain available to agreement and reliability statistics. The token is
stored in the config directory with mode 0600 and is read by the Paseo plugin server when it
reports outcomes. A same-user process without a sandbox can still read it.
