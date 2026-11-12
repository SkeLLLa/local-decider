/**
 * Policies are data: one YAML file per decision type with its questions, how state is built from
 * the harness input, and confidence-gated rules that map answers to an action.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { Answers, Questions } from './systemone.ts';
import type { StateSection } from './truncate.ts';

export const MODES = ['off', 'shadow', 'act'] as const;
export type Mode = (typeof MODES)[number];

/** The lower of two modes, ordered off < shadow < act. */
export function minMode(a: Mode, b: Mode): Mode {
  return MODES.indexOf(a) <= MODES.indexOf(b) ? a : b;
}

/**
 * `abstain` means "no opinion, harness default"; `log` records only; `notify` asks the adapter to
 * surface the decision; `route:<preset>` names a routing preset.
 */
const ACTION_PATTERN = /^(?:allow|ask|deny|log|abstain|notify|route:[a-z0-9][a-z0-9_.-]*)$/;
export type Action = string;
const ROUTE_PREFIX = 'route:';

const ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const sentence = z.string().trim().min(1).max(600);

const noulSchema = z.strictObject({
  type: z.literal('noul'),
  instructions: sentence,
  criteria: z.strictObject({ true: sentence.optional(), false: sentence.optional() }).optional(),
});

const choiceSchema = z.strictObject({
  type: z.literal('choice'),
  instructions: sentence,
  criteria: z
    .record(z.string().regex(ID_PATTERN), sentence.nullable())
    .refine((c) => Object.keys(c).length >= 2 && Object.keys(c).length <= 255, {
      message: 'choice questions need 2..255 options',
    }),
});

const scoreSchema = z.strictObject({
  type: z.literal('score'),
  instructions: sentence,
  criteria: z.array(sentence).min(2).max(10),
});

const questionSchema = z
  .discriminatedUnion('type', [noulSchema, choiceSchema, scoreSchema])
  .describe(
    'noul: yes/no (answers `true`/`false`); choice: one of 2..255 options (answers the option id); score: ordered levels (answers the level text). Criteria: short, mutually exclusive, with concrete examples.',
  );

const sectionSchema = z.strictObject({
  label: z.string().min(1).max(80),
  /** Key of the harness input to render into this section. */
  from: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .describe('Key of the harness input rendered here, e.g. `prompt`, `project`, `history`.'),
  keep: z
    .enum(['head', 'tail', 'middle'])
    .default('tail')
    .describe('Which part survives truncation.'),
});

const precedentSchema = z.strictObject({
  from: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .describe('Harness input key used for exact-match outcome precedent; never rendered as state.'),
  minAllows: z.number().int().min(2).default(3),
  maxAgeDays: z.number().int().min(1).max(90).default(14),
  sources: z
    .array(z.enum(['user', 'supervised', 'harness', 'heuristic', 'classifier']))
    .default(['user']),
});

const ruleSchema = z.strictObject({
  when: z.strictObject({
    question: z.string().regex(ID_PATTERN),
    answer: z.string().min(1),
    minConfidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Normalised confidence: 0 = uniform, 1 = certain.'),
    minProbability: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Probability of the named answer.'),
    precedent: z.literal('allow').optional(),
  }),
  action: z
    .string()
    .regex(ACTION_PATTERN)
    .describe('allow, ask, deny, log, notify, abstain, or route:<preset>.'),
});

export const policySchema = z
  .strictObject({
    id: z.string().regex(ID_PATTERN).describe('Policy id; also the file name (`<id>.yaml`).'),
    version: z.union([z.literal(1), z.literal(2)]),
    description: z.string().min(1).describe('One line: what this decides.'),
    /**
     * Id of the policy this one can stand in for. Adapters keep asking for that id; the gateway
     * answers with whichever variant the user selected (the policy with that id by default).
     */
    variantOf: z
      .string()
      .regex(ID_PATTERN)
      .optional()
      .describe('Id of the policy this one can answer for when selected (e.g. `routing`).'),
    mode: z
      .enum(MODES)
      .default('shadow')
      .describe('Default run mode; config.yaml `policies.<id>.mode` overrides it.'),
    /**
     * Engine queue priority. Engines answer one request at a time, so policies a hook waits on
     * (`high`) go ahead of background ones (`low`, e.g. turn outcomes) instead of timing out.
     */
    priority: z
      .enum(['high', 'normal', 'low'])
      .default('normal')
      .describe('Engine queue priority: `high` for decisions a hook waits on.'),
    /** Harness ids this policy applies to; empty = all. */
    harnesses: z.array(z.string().regex(ID_PATTERN)).default([]),
    state: z
      .strictObject({
        maxTokens: z.number().int().min(128).max(32_000).default(3000),
        sections: z.array(sectionSchema).min(1),
      })
      .describe(
        'What the model reads: input keys in order, least relevant first, within maxTokens.',
      ),
    precedent: precedentSchema.optional(),
    questions: z
      .record(z.string().regex(ID_PATTERN), questionSchema)
      .refine((q) => Object.keys(q).length >= 1, {
        message: 'a policy needs at least one question',
      }),
    /** First matching rule wins. */
    rules: z.array(ruleSchema).default([]).describe('Checked in order; the first match wins.'),
    /** Action when no rule matches or the engine gave no answer. */
    default: z
      .string()
      .regex(ACTION_PATTERN)
      .default('abstain')
      .describe('Action when no rule matches or the engine failed.'),
    cache: z
      .strictObject({ ttlSeconds: z.number().int().min(0).max(86_400).default(0) })
      .default({ ttlSeconds: 0 }),
  })
  .superRefine(validatePolicy);

export type Policy = z.infer<typeof policySchema>;
export type PolicyRule = Policy['rules'][number];

function answerSpace(question: z.infer<typeof questionSchema>): string[] {
  if (question.type === 'noul') {
    return ['true', 'false'];
  }
  if (question.type === 'choice') {
    return Object.keys(question.criteria);
  }
  return question.criteria;
}

function validatePolicy(policy: PolicyShape, ctx: z.RefinementCtx): void {
  if (policy.variantOf === policy.id) {
    ctx.addIssue({
      code: 'custom',
      path: ['variantOf'],
      message: 'a policy cannot be its own variant',
    });
  }
  if (policy.default === 'allow') {
    ctx.addIssue({
      code: 'custom',
      path: ['default'],
      message: 'policy default cannot be allow; use a thresholded allow rule',
    });
  }
  validateRules(policy, ctx);
}

type PolicyShape = z.infer<typeof policySchema>;

function validateRules(policy: PolicyShape, ctx: z.RefinementCtx): void {
  for (const [i, rule] of policy.rules.entries()) {
    validateRule(policy, rule, i, ctx);
  }
}

function validateRule(
  policy: PolicyShape,
  rule: PolicyRule,
  index: number,
  ctx: z.RefinementCtx,
): void {
  validateRuleAction(policy, rule, index, ctx);
  const question = policy.questions[rule.when.question];
  if (question === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['rules', index, 'when', 'question'],
      message: `unknown question "${rule.when.question}"`,
    });
    return;
  }
  const answers = answerSpace(question);
  if (!answers.includes(rule.when.answer)) {
    ctx.addIssue({
      code: 'custom',
      path: ['rules', index, 'when', 'answer'],
      message: `"${rule.when.answer}" is not one of ${answers.join(', ')}`,
    });
  }
}

function validateRuleAction(
  policy: PolicyShape,
  rule: PolicyRule,
  index: number,
  ctx: z.RefinementCtx,
): void {
  if (rule.when.precedent !== undefined && policy.precedent === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['rules', index, 'when', 'precedent'],
      message: 'precedent rules require policy.precedent',
    });
  }
  if (rule.when.precedent !== undefined && !['allow', 'ask'].includes(rule.action)) {
    ctx.addIssue({
      code: 'custom',
      path: ['rules', index, 'action'],
      message: 'precedent rules may only use allow or ask actions',
    });
  }
  const thresholds = [rule.when.minConfidence, rule.when.minProbability].filter(
    (value): value is number => value !== undefined,
  );
  if (
    rule.action === 'allow' &&
    rule.when.precedent === undefined &&
    !thresholds.some((value) => value >= ALLOW_THRESHOLD_FLOOR)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['rules', index, 'when'],
      message: `allow rules need minConfidence or minProbability at least ${ALLOW_THRESHOLD_FLOOR}`,
    });
  }
}

export class PolicyError extends Error {
  override readonly name = 'PolicyError';
}

/** Parse and validate one policy document. Throws {@link PolicyError} with every issue listed. */
export function parsePolicy(source: string, origin = '<policy>'): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(source, { uniqueKeys: true });
  } catch (error) {
    throw new PolicyError(`${origin}: invalid YAML: ${(error as Error).message}`);
  }
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new PolicyError(`${origin}: invalid policy\n${issues}`);
  }
  return result.data;
}

/** The questions in wire form (criteria nulls kept, as the API allows them). */
export function policyQuestions(policy: Policy): Questions {
  return policy.questions as Questions;
}

/** Render harness input into ordered state sections per the policy's `state.sections`. */
export function policySections(
  policy: Policy,
  input: Readonly<Record<string, unknown>>,
  render: (value: unknown) => string,
): StateSection[] {
  return policy.state.sections.map((section) => ({
    label: section.label,
    keep: section.keep,
    text: render(input[section.from]),
  }));
}

export interface RuleMatch {
  readonly action: Action;
  /** Index of the matching rule, or -1 for the policy default. */
  readonly rule: number;
}

function ruleMatches(
  rule: PolicyRule,
  answers: Answers,
  context: { precedentAllows: boolean },
): boolean {
  if (rule.when.precedent === 'allow' && !context.precedentAllows) {
    return false;
  }
  const answer = answers[rule.when.question];
  if (answer === undefined || answer.answer !== rule.when.answer) {
    return false;
  }
  if (rule.when.minConfidence !== undefined && answer.confidence < rule.when.minConfidence) {
    return false;
  }
  const p = answer.probabilities[rule.when.answer] ?? 0;
  return rule.when.minProbability === undefined || p >= rule.when.minProbability;
}

/** Map answers to an action: first matching rule, else the policy default. */
export function evaluateRules(
  policy: Policy,
  answers: Answers,
  context: { precedentAllows: boolean } = { precedentAllows: false },
): RuleMatch {
  const index = policy.rules.findIndex((rule) => ruleMatches(rule, answers, context));
  const rule = policy.rules[index];
  return rule === undefined
    ? { action: policy.default, rule: -1 }
    : { action: rule.action, rule: index };
}

/** Preset names the policy can route to (`route:<preset>` in its rules or default), in order. */
export function policyRoutes(policy: Policy): string[] {
  const actions = [...policy.rules.map((rule) => rule.action), policy.default];
  const routes = actions
    .filter((action) => action.startsWith(ROUTE_PREFIX))
    .map((action) => action.slice(ROUTE_PREFIX.length));
  return [...new Set(routes)];
}

/**
 * Lowest threshold an override may give an `allow` rule: below it the model would auto-allow
 * answers it leans against. The gateway refuses lower values and clamps config.yaml ones.
 */
export const ALLOW_THRESHOLD_FLOOR = 0.8;

/** Which bound a rule's threshold is: config.yaml overrides replace it in place. */
type ThresholdKind = 'minProbability' | 'minConfidence';

/** One configurable rule threshold, named `<question>.<answer>`. */
export interface PolicyThreshold {
  readonly key: string;
  readonly question: string;
  readonly answer: string;
  /** Action of the first rule with this key. */
  readonly action: Action;
  readonly kind: ThresholdKind;
  /** The policy file's value; null when the rule has no threshold. */
  readonly default: number | null;
  /** The value in effect: the override (never below `floor`), else the default. */
  readonly value: number | null;
  /** Lowest override accepted: {@link ALLOW_THRESHOLD_FLOOR} when a rule with this key allows. */
  readonly floor: number;
}

/** `<question>.<answer>`: how config.yaml `policies.<id>.thresholds` names a rule. */
function thresholdKey(rule: PolicyRule): string {
  return `${rule.when.question}.${rule.when.answer}`;
}

function ruleThreshold(rule: PolicyRule): { kind: ThresholdKind; value: number | null } {
  if (rule.when.minProbability !== undefined) {
    return { kind: 'minProbability', value: rule.when.minProbability };
  }
  return { kind: 'minConfidence', value: rule.when.minConfidence ?? null };
}

function floorOf(rules: readonly PolicyRule[], key: string): number {
  return rules.some(
    (rule) =>
      rule.when.precedent === undefined && rule.action === 'allow' && thresholdKey(rule) === key,
  )
    ? ALLOW_THRESHOLD_FLOOR
    : 0;
}

/** The override for `key`, raised to the floor of the rules it applies to. */
function override(
  overrides: Readonly<Record<string, number>>,
  key: string,
  floor: number,
): number | undefined {
  const value = Object.hasOwn(overrides, key) ? overrides[key] : undefined;
  return value === undefined ? undefined : Math.max(value, floor);
}

/**
 * The policy with overridden thresholds: a rule whose `<question>.<answer>` is in `overrides` gets
 * that value as its `minProbability` if it has one, else as its `minConfidence`. Unknown keys are
 * ignored; an `allow` rule never goes below {@link ALLOW_THRESHOLD_FLOOR}.
 */
export function withThresholds(
  policy: Policy,
  overrides: Readonly<Record<string, number>>,
): Policy {
  if (Object.keys(overrides).length === 0) {
    return policy;
  }
  const rules = policy.rules.map((rule): PolicyRule => {
    if (rule.when.precedent !== undefined) {
      return rule;
    }
    const key = thresholdKey(rule);
    const value = override(overrides, key, floorOf(policy.rules, key));
    if (value === undefined) {
      return rule;
    }
    return ruleThreshold(rule).kind === 'minProbability'
      ? { ...rule, when: { ...rule.when, minProbability: value } }
      : { ...rule, when: { ...rule.when, minConfidence: value } };
  });
  return { ...policy, rules };
}

/** Every rule threshold of `policy`, one per `<question>.<answer>` in rule order. */
export function policyThresholds(
  policy: Policy,
  overrides: Readonly<Record<string, number>> = {},
): PolicyThreshold[] {
  const out = new Map<string, PolicyThreshold>();
  for (const rule of policy.rules) {
    if (rule.when.precedent !== undefined) {
      continue;
    }
    const key = thresholdKey(rule);
    if (out.has(key)) {
      continue;
    }
    const { kind, value } = ruleThreshold(rule);
    const floor = floorOf(policy.rules, key);
    out.set(key, {
      key,
      question: rule.when.question,
      answer: rule.when.answer,
      action: rule.action,
      kind,
      default: value,
      value: override(overrides, key, floor) ?? value,
      floor,
    });
  }
  return [...out.values()];
}
