# ADR-0002: Engine interface and normalisation

Status: accepted (2026-11-10)

## Decision

Engines implement `start`, `health`, `decide(SystemOneRequest) → SystemOneResponse`, `stop`. The
wire contract is Strands Decider's `/v1/systemone` (`noul`, `choice`, `score`). The gateway, not
the engine, computes the normalised `Answer` (`core/systemone.ts`): a probability per option and
a confidence using Strands' formulas for every engine — choice `(N·p_max − 1)/(N − 1)`, noul
`|2p − 1|`, score `(σ_max − σ)/σ_max` — so thresholds mean the same thing whichever engine
answered. An engine-reported confidence is kept when present (Strands' own); engines with a
different formula (Laya) are recomputed in their adapter.

Each engine has one request in flight; requests queue with their caller's deadline. All
questions of a policy go in one request so the engine encodes the state once.

## Consequences

Adding an engine means mapping its output onto `SystemOneResponse`; policies and adapters are
untouched. Calibration still differs between models, so thresholds are per policy and tuned from
shadow data, not assumed portable.
