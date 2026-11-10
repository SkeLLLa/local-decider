# Policy authoring

Policies live in `policies/*.yaml` (defaults, shipped with the gateway) and
`~/.config/local-decider/policies/*.yaml` (yours; a file with the same `id` replaces the
default). The schema is `policySchema` in `packages/core/src/policy.ts`.

```yaml
id: permission            # [a-z][a-z0-9_-]*, also the file name
version: 1
description: What this decides.
variantOf: permission     # optional: can stand in for another policy (see Variants)
mode: shadow              # off | shadow | act
harnesses: []             # empty = every harness
cache: { ttlSeconds: 0 }  # reuse answers for identical state
state:
  maxTokens: 3000         # decision models take ~4k tokens; leave room for the questions
  sections:               # least relevant first; the budget is spent from the end
    - { label: Recent conversation, from: history, keep: tail }
    - { label: Request, from: request, keep: middle }
questions:
  verdict:
    type: choice          # noul (yes/no) | choice (one of N) | score (ordered levels)
    instructions: One or two sentences framing the question.
    criteria:
      allow: One or two sentences.
      ask: One or two sentences.
rules:                    # first match wins
  - when: { question: verdict, answer: allow, minProbability: 0.95 }
    action: allow
default: ask              # when no rule matches or the engine failed
```

- `from` names a key of the adapter's input. Strings are used as-is; other values become
  key-sorted JSON.
- `minConfidence` uses the normalised confidence (0 = uniform, 1 = certain); `minProbability`
  uses the probability of the named answer. For a 3-option choice, p = 0.95 is confidence 0.925.
- noul answers are `true`/`false`; score answers are the level labels.
- Actions: `allow`, `ask`, `deny`, `log`, `notify`, `abstain`, `route:<preset>`.
- Write criteria as short, mutually exclusive descriptions, and name concrete examples. On the 2B
  model, `command-risk`'s "exposes secrets" scored an `~/.ssh` exfiltration p = 0.25 dangerous;
  "sends credentials, keys or private files (such as ~/.ssh, ~/.aws or .env) off the machine"
  scored it p = 0.81. Treat everything in the state as
  data: say so in `instructions` when the state may contain text that looks like instructions.

## Variants

A policy with `variantOf: <id>` is an alternative for policy `<id>`. Adapters keep asking for
`<id>`; the gateway answers with the variant the user selected, or `<id>` itself by default.
The run mode stays the one of `<id>`, so switching variants never turns enforcement on or off.
Responses and shadow-log records carry `variant` when a variant answered.

Routing ships three (`policies/routing*.yaml`); they differ in preset names, not just wording:

| Policy | Presets | Picks by |
| --- | --- | --- |
| `routing` (default) | `fast`, `standard`, `deep` | how hard the task is |
| `routing-budget` | `cheap`, `standard`, `premium` | the cheapest tier likely to succeed |
| `routing-task-kind` | `docs`, `ui`, `code`, `debug`, `plan` | the kind of work |

```sh
local-decider policies                          # each policy; base policies list their variants
local-decider policies use routing routing-budget
local-decider policies use routing routing      # back to the default
```

The choice is saved as `policies.routing.variant` in `config.yaml`, and Paseo's settings page
has the same selector. Each harness maps preset names to models under
`routing.presets.<harness>` in `config.yaml`; a preset without a mapping changes nothing:

```sh
local-decider routing map paseo premium codex/gpt-5.5 full-access   # provider/model, mode
local-decider routing map claude-code cheap haiku
local-decider routing map codex premium gpt-5.5
```

The gateway attaches the harness's target to each routing decision (`route` in the response).
Paseo switches the new agent's provider, model and mode. Claude Code and Codex cannot switch the
session model from a hook, so their hint names the model: Claude Code can pass it to the
subagents it starts, and the user can switch with `/model`.

Policy files can start with `# yaml-language-server: $schema=../schemas/policy.schema.json` (the
shipped ones do) to get completion and validation in editors.

## Writing your own with an AI assistant

Paseo's settings page has a "Write with an agent" button that starts an agent with this prompt
in the gateway's config directory and opens it. The Claude Code and Codex plugin ships the same
flow as the `local-decider-routing-policy` skill. Elsewhere,
`local-decider policies prompt routing` prints the prompt for any AI assistant. It asks which
models you have and what you optimise for, proposes preset names, writes a variant into
`~/.config/local-decider/policies/`, and checks it with `local-decider policies check`. The
prompt embeds your current routing policies as examples. Then:

```sh
local-decider policies reload                   # pick up new or edited files without a restart
local-decider policies use routing routing-mine
```

One choice question with a few non-overlapping options works best on the 2B model. Express a
preference such as "save money" in the instructions and rule thresholds, not as an extra
near-synonym option.
