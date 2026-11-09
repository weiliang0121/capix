import { ChildCallFailure, DeclaredException } from '@weiliang0121/capix-invocation';
import { z } from 'zod';
import { modelOutputRejected } from './rejection.js';
import { modelRequestSchema, modelOutputSchema } from './interactions.js';
import type { ModelOutput, ModelRequest } from './types.js';

export interface ModelRegenerationInput {
  readonly request: ModelRequest;
  readonly output: ModelOutput;
  readonly error: { readonly code: string; readonly message: string };
}

/** A service policy for a complete but invalid answer, not a runtime execution round. */
export const modelRegenerationDeclaration = Object.freeze({
  after: 'completed-output-rejected',
  maxAdditionalCalls: 1,
  rejectionCodes: Object.freeze(['INVALID_JSON', 'EMPTY_OUTPUT', 'OUTPUT_SHAPE']),
} as const);

export const modelRegenerationSchema = z.strictObject({
  request: modelRequestSchema,
  output: modelOutputSchema,
  error: z.strictObject({ code: z.enum(modelRegenerationDeclaration.rejectionCodes), message: z.string() }),
});

/** The receiver belongs to one exact candidate; only its declared validation failure permits retry. */
export function modelRegenerationInput(request: ModelRequest, failure: unknown): ModelRegenerationInput | undefined {
  const exception = failure instanceof ChildCallFailure ? failure.exception : failure;
  if (!(exception instanceof DeclaredException) || exception.contract !== modelOutputRejected) return undefined;
  const facts = z.strictObject({ code: z.enum(modelRegenerationDeclaration.rejectionCodes), output: modelOutputSchema }).safeParse(exception.facts);
  if (!facts.success || facts.data.output.finishReason !== 'stop') return undefined;
  return { request, output: facts.data.output, error: { code: facts.data.code, message: exception.message } };
}

export function prepareRegenerationRequest(input: ModelRegenerationInput): ModelRequest {
  return {
    ...input.request,
    messages: [...input.request.messages, { role: 'assistant', content: input.output.content }, { role: 'user', content: `上一次返回未通过输出契约检查：${input.error.code}，${input.error.message}\n请依据原始请求重新生成完整 JSON，严格遵守原有 Schema，不添加解释或代码围栏。` }],
  };
}
