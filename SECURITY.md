# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/ziptie-soft/local-decider/security/advisories/new).
Do not open a public issue.

Include the affected package and version, what an attacker can do, and steps to reproduce. You
should get a first answer within a week. Fixes are released as new npm versions and announced in
a GitHub security advisory.

## Supported versions

Only the latest published version of each package gets security fixes:

- `@ziptie-soft/local-decider`
- `@ziptie-soft/local-decider-core`
- `@ziptie-soft/local-decider-agent-plugin`
- `@ziptie-soft/paseo-plugin-local-decider`

## Scope

What local-decider trusts, what it protects and its known limits are described in the
[threat model](docs/security.md). Issues it lists as out of scope, such as prompt injection
steering a label or a process running as the same user, are not vulnerabilities on their own.
