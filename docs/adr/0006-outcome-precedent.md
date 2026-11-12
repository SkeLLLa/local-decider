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

## Addendum (2026-11-12): typed outcome labels

Outcomes stay free strings (turn policies report their own answers); the gateway gives a few of
them fixed meanings (`gateway/src/outcome-labels.ts`):

| Outcome                       | Class   | Precedent                           | Calibration and agreement             |
| ----------------------------- | ------- | ----------------------------------- | ------------------------------------- |
| `allow`                       | allow   | +1 allow, only on `ask` decisions   | allowed sample; compared as `allow`   |
| `deny` (legacy), `unsafe`     | veto    | +1 deny (veto)                      | denied sample; compared as `deny`     |
| `decline`, `interrupted`      | neutral | ignored                             | ignored; not counted as labelled      |
| anything else                 | other   | ignored                             | unchanged                             |

- **Corrections.** A decision's effective verified outcome is its first verified outcome, except
  that a neutral one may be corrected once to a veto. Nothing moves towards `allow`: labels never
  create allow evidence. In the precedent store the label lives in the pending decision, so
  eviction forgets both together. Corrections are appended `outcome` rows; there is no
  migration. Calibration hints use the same fold.
- **Vetoes on auto-allows.** Keyed `allow` decisions are remembered in a separate LRU and accept
  only vetoes, extending "only escalated decisions collect labels" to "only escalated decisions
  collect allow evidence". Startup replays keyed auto-allows from the last 25 hours (even without
  outcomes) and older ones that already have a verified veto, so a first veto after a restart
  lands.
- **Paseo default.** An unlabelled decline is `decline` (neutral), not `deny`: most declines are
  off-task, and a neutral default never increases automation. Only an explicit
  `interrupt: true` maps to `interrupted`; otherwise `decline`. Both are neutral, so a
  mislabelled interrupt changes only the row text.
- **Chips.** After a decline or interrupt the row offers *Not a safety issue*, *Unsafe* and
  *Skip*; a keyed auto-allowed row offers *Mark unsafe*. Only `unsafe` is reported. Chips work
  for at most 24 hours and one tap; the Paseo daemon checks this against rows it drew itself, so
  after a daemon restart older rows can no longer be labelled.
- **Statistics.** Agreement compares `unsafe` as `deny` and excludes `decline` and `interrupted`.
  Agreement uses the latest outcome; calibration uses the verified fold (first wins, a neutral
  one corrected once to a veto).
- **Auto-allows.** Only an eligible veto touches a keyed auto-allow; other outcomes leave it open.
  The pending-allow LRU is capped at 10 000; an evicted one gets no live veto but is replayed at
  restart. That fails safe: it adds no allow evidence.
- **Veto lifetime.** A veto lasts `maxAgeDays` (14 by default) from the earlier of decision and
  outcome.
- A veto blocks only the precedent rule: a rule with a higher threshold (p ≥ 0.95) can still
  allow the same request.
