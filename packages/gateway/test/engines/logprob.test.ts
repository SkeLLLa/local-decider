import type { Question } from '@local-decider/core';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  optionMasses,
  parseTopLogprobs,
  renderPrompt,
  toWireAnswer,
  type TopLogprob,
} from '../../src/engines/openai/logprob.ts';

const choice: Question = {
  type: 'choice',
  instructions: 'Which option applies?',
  criteria: { allow: 'The request is safe.', deny: 'The request is unsafe.' },
};

function near(actual: number | undefined, expected: number): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-10);
}

function probability(token: string, value: number): TopLogprob {
  return { token, logprob: Math.log(value) };
}

describe('OpenAI-compatible logprob mapping', () => {
  it('renders labels and aggregates their token variants', () => {
    const prompt = renderPrompt(choice, 'state text');
    assert.deepEqual(prompt.labels, [
      { label: 'A', key: 'allow' },
      { label: 'B', key: 'deny' },
    ]);
    assert.match(prompt.user, /A\. allow: The request is safe\./);
    assert.match(prompt.prompt, /Answer:$/);

    const masses = optionMasses(choice, [
      probability('A', 0.1),
      probability(' A', 0.2),
      probability('(a).', 0.1),
      probability('b:', 0.4),
      probability('?', 0.1),
    ]);
    assert.ok(masses);
    near(masses.coverage, 0.8);
    near(masses.probabilities['allow'], 0.5);
    near(masses.probabilities['deny'], 0.5);
    const answer = toWireAnswer(choice, masses);
    assert.ok(answer?.type === 'choice');
    assert.equal(answer.choice, 'allow');
    near(answer.probabilities['allow'], 0.5);
    near(answer.probabilities['deny'], 0.5);
  });

  it('recognizes yes/no token variants for noul questions', () => {
    const question: Question = { type: 'noul', instructions: 'Is it true?' };
    const masses = optionMasses(question, [
      probability('yes', 0.2),
      probability(' y', 0.1),
      probability('TRUE', 0.2),
      probability('no', 0.5),
    ]);
    assert.ok(masses);
    near(masses.probabilities['true'], 0.5);
    near(masses.probabilities['false'], 0.5);
    assert.deepEqual(toWireAnswer(question, masses), { type: 'noul', noul: 0.5 });
  });

  it('maps a single-letter N choice label without treating it as no', () => {
    const keys = Array.from({ length: 14 }, (_, index) => `option-${index + 1}`);
    const question: Question = {
      type: 'choice',
      instructions: 'Pick one.',
      criteria: Object.fromEntries(keys.map((key) => [key, `Description for ${key}`])),
    };
    const masses = optionMasses(question, [probability(' N', 0.9), probability('?', 0.01)], {
      maxOptions: 14,
    });
    assert.ok(masses);
    assert.equal(masses.coverage, 0.9);
    const answer = toWireAnswer(question, masses);
    assert.ok(answer?.type === 'choice');
    assert.equal(answer.choice, 'option-14');
  });

  it('floors missing options at the least likely observed token', () => {
    const question: Question = {
      type: 'choice',
      instructions: 'Pick one.',
      criteria: { first: 'One', second: 'Two', third: 'Three' },
    };
    const masses = optionMasses(question, [probability('A', 0.6), probability('C', 0.2)]);
    assert.ok(masses);
    near(masses.coverage, 0.8);
    near(masses.probabilities['first'], 0.6);
    near(masses.probabilities['second'], 0.2);
    near(masses.probabilities['third'], 0.2);
  });

  it('omits an answer below the configured coverage threshold', () => {
    const masses = optionMasses(choice, [probability('?', 0.1)]);
    assert.ok(masses);
    near(masses.coverage, 0);
    assert.equal(toWireAnswer(choice, masses), undefined);

    const lowerThreshold = optionMasses(choice, [probability('A', 0.3)], { minCoverage: 0.2 });
    assert.ok(lowerThreshold);
    assert.ok(toWireAnswer(choice, lowerThreshold)?.type === 'choice');
  });

  it('omits questions with more options than maxOptions', () => {
    const question: Question = {
      type: 'choice',
      instructions: 'Pick one.',
      criteria: { first: 'One', second: 'Two', third: 'Three' },
    };
    assert.equal(
      optionMasses(question, [probability('A', 0.6), probability('B', 0.3)], { maxOptions: 2 }),
      undefined,
    );
  });

  it('applies temperature and maps score distributions to expected values', () => {
    const masses = optionMasses(choice, [probability('A', 0.8), probability('B', 0.2)], {
      temperature: 2,
    });
    assert.ok(masses);
    near(masses.probabilities['allow'], 2 / 3);

    const score: Question = {
      type: 'score',
      instructions: 'Rate it.',
      criteria: ['low', 'medium', 'high'],
    };
    const scoreMasses = optionMasses(score, [
      probability('0', 0.2),
      probability('1', 0.3),
      probability('2', 0.5),
    ]);
    assert.ok(scoreMasses);
    const answer = toWireAnswer(score, scoreMasses);
    assert.ok(answer?.type === 'score');
    near(answer.score, 1.3);
    near(answer.probabilities['0'], 0.2);
    near(answer.probabilities['1'], 0.3);
    near(answer.probabilities['2'], 0.5);
    assert.deepEqual(answer.legend, { '0': 'low', '1': 'medium', '2': 'high' });
  });

  it('parses chat-completions and legacy completions logprobs, including null', () => {
    const chat = parseTopLogprobs({
      choices: [
        {
          logprobs: {
            content: [
              {
                top_logprobs: [
                  { token: 'A', logprob: -0.1 },
                  { token: 'B', logprob: -2 },
                ],
              },
            ],
          },
        },
      ],
    });
    assert.deepEqual(chat, [
      { token: 'A', logprob: -0.1 },
      { token: 'B', logprob: -2 },
    ]);

    const completions = parseTopLogprobs({
      choices: [{ logprobs: { top_logprobs: [{ A: -0.1, B: -2 }] } }],
    });
    assert.deepEqual(completions, [
      { token: 'A', logprob: -0.1 },
      { token: 'B', logprob: -2 },
    ]);
    assert.deepEqual(parseTopLogprobs({ choices: [{ logprobs: null }] }), []);
  });

  it('uses the first answer position after thinking and whitespace in both response shapes', () => {
    const entries = [
      { token: 'A', logprob: -0.1 },
      { token: 'B', logprob: -2 },
    ];
    const chat = parseTopLogprobs({
      choices: [
        {
          logprobs: {
            content: [
              { token: '<think>', top_logprobs: [{ token: '<think>', logprob: -0.01 }] },
              { token: '</think>', top_logprobs: [{ token: '</think>', logprob: -0.02 }] },
              { token: '\n\n', top_logprobs: [{ token: '\n', logprob: -0.03 }] },
              { token: 'A', top_logprobs: entries },
            ],
          },
        },
      ],
    });
    assert.deepEqual(chat, entries);

    const completions = parseTopLogprobs({
      choices: [
        {
          logprobs: {
            tokens: ['<think>', '</think>', '\n\n', 'A'],
            top_logprobs: [
              { '<think>': -0.01 },
              { '</think>': -0.02 },
              { '\n': -0.03 },
              { A: -0.1, B: -2 },
            ],
          },
        },
      ],
    });
    assert.deepEqual(completions, [
      { token: 'A', logprob: -0.1 },
      { token: 'B', logprob: -2 },
    ]);
  });

  it('keeps the first-position behavior for a single generated token', () => {
    assert.deepEqual(
      parseTopLogprobs({
        choices: [
          {
            logprobs: {
              content: [{ token: '<think>', top_logprobs: [{ token: 'A', logprob: -0.1 }] }],
            },
          },
        ],
      }),
      [{ token: 'A', logprob: -0.1 }],
    );
  });
});
