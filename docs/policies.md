# Policy authoring

Policies live in `policies/*.yaml` (defaults, shipped with the gateway) and
`~/.config/local-decider/policies/*.yaml` (yours; a file with the same `id` replaces the
default). The schema is `policySchema` in `packages/core/src/policy.ts`.

```yaml
id: permission            # [a-z][a-z0-9_-]*, also the file name
version: 1
description: What this decides.
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
