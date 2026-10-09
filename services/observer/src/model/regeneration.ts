import { RuntimeError, isObject, type InvocationView, type InvocationRelationView, type OperationScope } from '@capix-observer/runtime';
import type { ModelOutput, ModelRequest } from './types.js';

export type ModelParent = InvocationView<unknown, unknown, OperationScope>;

/** Live evidence from one parent's direct children; never serialized as model input. */
export interface ModelRegenerationEvidence {
  previous: InvocationRelationView;
  rejection: InvocationRelationView;
}

export interface ModelRegenerationInput {
  request: ModelRequest;
  output: ModelOutput;
  error: { code: string; message: string };
}

/** This capability is specific to the current text-only, non-tool model endpoint. */
export const modelRegenerationDeclaration = Object.freeze({
  after: 'completed-output-rejected',
  maxAdditionalCalls: 1,
  rejectionCodes: Object.freeze(['INVALID_JSON', 'EMPTY_OUTPUT', 'OUTPUT_SHAPE']),
} as const);

/** Recheck actual delivery and direct ownership, not just the parent's proposed reason. */
export function allowsModelRegeneration(parent: ModelParent, evidence: ModelRegenerationEvidence): boolean {
  const { previous, rejection } = evidence;
  const children = parent.children.values();
  if (parent.context.status !== 'running' || parent.context.signal.aborted) return false;
  if (!children.includes(previous) || !children.includes(rejection) || children.indexOf(previous) >= children.indexOf(rejection)) return false;
  if (!previous.key || previous.round !== 1 || rejection.round !== previous.round) return false;
  if (parent.context.progress.round !== previous.round && parent.context.progress.round !== previous.round + 1) return false;
  if (children.filter((child) => child.key === previous.key).length > modelRegenerationDeclaration.maxAdditionalCalls) return false;
  if (previous.returned?.status !== 'succeeded' || previous.invocation.context.status !== 'succeeded' || previous.reception.status !== 'accepted') return false;
  if (rejection.returned?.status !== 'failed' || rejection.invocation.context.status !== 'failed' || rejection.reception.status !== 'pending') return false;
  const error = rejection.returned.error;
  if (!(error instanceof RuntimeError) || !modelRegenerationDeclaration.rejectionCodes.some((code) => code === error.code)) return false;
  const acceptance = rejection.invocation.context.input;
  if (!isObject(acceptance) || acceptance.output !== previous.returned.output) return false;
  // The evidence comes from the model/acceptance positions of this composition.
  const output = previous.returned.output;
  return isObject(output) && output.finishReason === 'stop';
}

export function modelRegenerationInput(parent: ModelParent, evidence: ModelRegenerationEvidence): ModelRegenerationInput {
  if (!allowsModelRegeneration(parent, evidence)) throw new RuntimeError('MODEL_REGENERATION_NOT_ALLOWED', '本次模型调用不满足再次生成的声明与条件。');
  const result = evidence.previous.returned!;
  const rejection = evidence.rejection.returned!;
  if (result.status !== 'succeeded' || rejection.status !== 'failed') throw new Error('Regeneration evidence changed');
  const error = rejection.error as RuntimeError;
  return { request: evidence.previous.invocation.context.input as ModelRequest, output: result.output as ModelOutput, error: { code: error.code, message: error.message } };
}

export function prepareRegenerationRequest(input: ModelRegenerationInput): ModelRequest {
  return {
    ...input.request,
    messages: [...input.request.messages, { role: 'assistant', content: input.output.content }, { role: 'user', content: `上一次返回未通过输出契约检查：${input.error.code}，${input.error.message}\n请依据原始请求重新生成完整 JSON，严格遵守原有 Schema，不添加解释或代码围栏。` }],
  };
}
