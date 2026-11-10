# Write a local-decider routing policy

You are helping me write a routing policy for local-decider. A small local model (about 2B
parameters) reads the start of a new coding task, answers fixed-choice questions about it, and a
rule turns the answer into `route:<preset>`. My coding-agent harness maps each preset to a
provider and model, so the policy decides which model a new task gets.

## Steps

1. Interview me in one short round of at most six questions, then wait for my answers:
   - which harnesses I use (Paseo, Claude Code, Codex) and which providers and models I can pick,
     with a rough price or speed for each;
   - what I want to optimise: cost, speed, quality, or matching models to kinds of work;
   - what my tasks usually look like (languages, frontend or backend, docs, debugging, reviews);
   - hard rules, such as "security work always goes to the strongest model".
2. Propose two to six preset names, one line each on what goes there and which of my models it
   should map to. Wait for me to confirm or adjust.
3. Write the policy, following the constraints below and the examples at the end.
4. Save it as `{{policyDir}}/<id>.yaml`, starting with the line
   `# yaml-language-server: $schema=../schemas/policy.schema.json` (the JSON Schema at
   `{{schemaFile}}` lists every field). Run `local-decider policies check <file>` and fix every
   reported issue until it prints `ok`.
5. With my agreement, select it and map its presets. Either run
   `local-decider policies use {{slot}} <id>` and
   `local-decider routing map <harness> <preset> <model>` for each preset and harness I use
   (`paseo` takes `provider/model`, `claude-code` takes `haiku`, `sonnet`, `opus` or a model id,
   `codex` takes a model id), or edit `{{configFile}}` directly: `policies.{{slot}}.variant` and
   `routing.presets.<harness>.<preset>.model`, following `{{configSchemaFile}}`. Run
   `local-decider config check` afterwards. A running gateway applies both files as they change.
6. Suggest I leave routing in shadow mode for a few days and check `local-decider stats` before
   letting it act.

## Constraints

The model is small: it picks one label per question and is only as good as the wording.

- Use one `choice` question with two to six options. Options must not overlap, and together they
  must cover every task. Write each criterion as a short description with concrete examples; at
  most 600 characters.
- Do not add near-synonyms as separate options (`cheap` and `fast`). A preference such as "save
  money" belongs in the instructions ("prefer the cheaper tier when unsure") and in the rule
  thresholds, not in an extra label.
- The model sees only the state sections. Available input keys: {{inputKeys}}. Do not invent
  others.
- Rules are checked in order and the first match wins. Put the expensive or rare presets first
  with a higher `minConfidence` (0.6 to 0.8) and the rest at 0.4 to 0.5. `default` is `abstain`
  (the harness keeps its own model) or the cheapest preset.
- Actions are `route:<preset>`; preset names match `[a-z0-9][a-z0-9_.-]*`.
- Fixed fields: `version: 1`, `variantOf: {{slot}}`, `mode: shadow`, `priority: high` (agent
  creation waits about two seconds for the answer), `cache: { ttlSeconds: 600 }`, and
  `state.maxTokens` at most 2000.
- `id` matches `[a-z][a-z0-9_-]*`, starts with `{{slot}}-` and differs from the examples.

## Examples

These are the policies I already have for `{{slot}}`:

{{examples}}
