import type { Answer } from '../../../shared/types.js';
import { RuntimeError } from '../../errors/error.js';
import { hasExactKeys, isObject } from '../../value/object.js';
import type { AnswerInput } from '../context/assemble.js';
import type { ModelOutputContract } from '../model.js';

const answerKinds = ['answer', 'unknown', 'needs-info'] as const;

export const answerOutputContract = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'content'],
    properties: {
      kind: { enum: answerKinds },
      content: { type: 'string', minLength: 1 },
    },
  },
  accept(value: unknown): Answer {
    checkAnswer(value);
    return value;
  },
} as const satisfies ModelOutputContract<AnswerInput, Answer>;

function checkAnswer(value: unknown): asserts value is Answer {
  // Local acceptance rejects whitespace-only content without rewriting the original text.
  if (!isObject(value) || !hasExactKeys(value, ['kind', 'content']) || !answerKinds.some((kind) => kind === value.kind) || typeof value.content !== 'string' || !value.content.trim()) {
    throw new RuntimeError('OUTPUT_SHAPE', '回答必须仅包含合法的 kind 和非空 content。');
  }
}
