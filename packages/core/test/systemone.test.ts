import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  choiceConfidence,
  normaliseAnswers,
  noulConfidence,
  scoreConfidence,
  type Questions,
} from '../src/index.ts';

const QUESTIONS: Questions = {
  urgent: { type: 'noul', instructions: 'Urgent?' },
  dept: { type: 'choice', instructions: 'Route.', criteria: { billing: 'money', technical: null } },
  level: { type: 'score', instructions: 'Angry?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
};

describe('confidence formulas', () => {
  it('choice: uniform is 0, one-hot is 1', () => {
    assert.equal(choiceConfidence({ a: 0.5, b: 0.5 }), 0);
    assert.equal(choiceConfidence({ a: 1, b: 0, c: 0 }), 1);
    assert.ok(Math.abs(choiceConfidence({ a: 0.773, b: 0.121, c: 0.106 }) - 0.6595) < 1e-3);
    assert.equal(choiceConfidence({ a: 1 }), 1);
  });

  it('noul: |2p - 1|', () => {
    assert.equal(noulConfidence(0.5), 0);
    assert.ok(Math.abs(noulConfidence(0.9) - 0.8) < 1e-9);
    assert.ok(Math.abs(noulConfidence(0.1) - 0.8) < 1e-9);
  });

  it('score: peaked is confident, split extremes are not', () => {
    assert.equal(scoreConfidence([0, 1, 0]), 1);
    assert.equal(scoreConfidence([0.5, 0, 0.5]), 0);
    assert.equal(scoreConfidence([1]), 1);
  });
});

describe('normaliseAnswers', () => {
  it('maps the three wire types', () => {
    const answers = normaliseAnswers(QUESTIONS, {
      answers: {
        urgent: { type: 'noul', noul: 0.8581 },
        dept: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.8, technical: 0.2 },
          confidence: 0.6,
        },
        level: { type: 'score', score: 1.03, probabilities: { '0': 0.196, '1': 0.574, '2': 0.23 } },
      },
    });
    assert.equal(answers['urgent']?.answer, 'true');
    assert.ok(Math.abs((answers['urgent']?.probabilities['false'] ?? 0) - 0.1419) < 1e-9);
    assert.equal(answers['dept']?.confidence, 0.6);
    assert.equal(answers['level']?.answer, 'Frustrated');
    assert.equal(answers['level']?.score, 1.03);
    assert.deepEqual(Object.keys(answers['level']?.probabilities ?? {}), [
      'Calm',
      'Frustrated',
      'Very angry',
    ]);
    assert.ok((answers['level']?.confidence ?? 0) > 0);
  });

  it('derives a missing choice confidence and an empty choice', () => {
    const answers = normaliseAnswers(QUESTIONS, {
      answers: {
        dept: { type: 'choice', choice: '', probabilities: { billing: 0.1, technical: 0.9 } },
      },
    });
    assert.equal(answers['dept']?.answer, 'technical');
    assert.ok(Math.abs((answers['dept']?.confidence ?? 0) - 0.8) < 1e-9);
  });

  it('drops missing and mistyped answers', () => {
    const answers = normaliseAnswers(QUESTIONS, {
      answers: { urgent: { type: 'choice', choice: 'x', probabilities: { x: 1 } } },
    });
    assert.deepEqual(answers, {});
  });

  it('drops non-finite noul values instead of reading them as confident', () => {
    const answers = normaliseAnswers(QUESTIONS, {
      answers: { urgent: { type: 'noul', noul: Number.NaN } },
    });
    assert.deepEqual(answers, {});
  });
});
