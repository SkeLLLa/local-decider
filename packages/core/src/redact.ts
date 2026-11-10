/**
 * Best-effort secret redaction for state sent to an engine or written to the shadow log. Patterns
 * are conservative: a false positive costs a little context, a false negative leaks a secret.
 */
interface RedactionRule {
  readonly kind: string;
  readonly pattern: RegExp;
  /** Capture group holding the secret; 0 replaces the whole match. */
  readonly group?: number;
}

const RULES: readonly RedactionRule[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { kind: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  },
  { kind: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'slack-token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: 'bearer', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  {
    kind: 'url-credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi,
  },
  {
    kind: 'assignment',
    // KEY=value / key: value / "key": "value" where the key names a secret.
    pattern:
      /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"',;}]{4,})/gi,
    group: 2,
  },
];

export interface RedactionResult {
  readonly text: string;
  /** Count of redactions per kind, safe to log. */
  readonly counts: Readonly<Record<string, number>>;
}

function replaceRule(text: string, rule: RedactionRule, counts: Record<string, number>): string {
  const label = `[REDACTED:${rule.kind}]`;
  return text.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
    counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
    if (rule.kind === 'bearer') {
      return `${String(groups[0])} ${label}`;
    }
    if (rule.kind === 'url-credentials') {
      return `${String(groups[0])}${label}${String(groups[1])}`;
    }
    if (rule.group === 2) {
      return `${String(groups[0])}${label}`;
    }
    return match.length > 0 ? label : match;
  });
}

export function redactSecrets(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of RULES) {
    out = replaceRule(out, rule, counts);
  }
  return { text: out, counts };
}

/** Redact every string inside a JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSecrets(value).text as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactDeep(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    ) as T;
  }
  return value;
}
