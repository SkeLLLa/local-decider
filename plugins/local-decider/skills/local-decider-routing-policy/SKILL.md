---
name: local-decider-routing-policy
description: Write a custom local-decider routing policy for the user (their own model tiers or task kinds, such as cheap vs premium, or docs vs debugging) and map its presets to models. Use when the user wants routing tuned to their models, budget or kinds of work.
---

# Write a local-decider routing policy

1. Run `local-decider policies prompt routing`. It prints the full instructions, including where
   policies go, the JSON Schema to follow, the input keys available, and the user's current
   routing policies as examples.
2. Follow those instructions exactly: interview the user first, propose presets and wait for
   confirmation, then write the file and run `local-decider policies check <file>` until it
   passes.
3. With the user's agreement, select it with `local-decider policies use routing <id>` and map
   each preset for the harnesses they use with `local-decider routing map <harness> <preset>
   <model>`. The running gateway picks up both changes without a restart.
