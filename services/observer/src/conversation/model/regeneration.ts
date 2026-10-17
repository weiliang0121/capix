import { modelOutputRejected } from './rejection.js';
import { RuntimeError, isObject, type ChildReference, type ChildFacts, type ContinuationFact } from '@capix/server-runtime';
import { isEqual } from 'es-toolkit';
import type { ModelOutput, ModelRequest } from './types.js';
import type { RequestModelDefinition } from '../operations/model/request.js';
import type { AcceptModelOutputDefinition, ModelAcceptanceInput } from '../attempt/model/accept.js';
import { z } from 'zod';

/** Read-only parent facts also used by the capability's alternate input entry. */
export interface ModelParentFacts {
  readonly round: 1 | 2;
  readonly continuation?: ContinuationFact;
  readonly children: ChildFacts;
}

/** Certified references, never embedded in the model request or acceptance input. */
export interface ModelRegenerationEvidence {
  readonly previous: ChildReference<RequestModelDefinition>;
  readonly rejection: ChildReference<AcceptModelOutputDefinition<ModelAcceptanceInput, any>>;
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

const rejectionDiagnostic = z.looseObject({ message: z.string(), detail: z.looseObject({ code: z.enum(modelRegenerationDeclaration.rejectionCodes), output: z.unknown() }) });

/** Recheck exact references and declared model identity, not a key or latest failure. */
export function allowsModelRegeneration(parent: ModelParentFacts, evidence: ModelRegenerationEvidence, model: RequestModelDefinition): boolean {
  const previous = parent.children.list(model).find((child) => child.ref === evidence.previous);
  const rejection = parent.children.values().find((child) => child.ref === evidence.rejection);
  if (!previous || !rejection) return false;
  if (previous.order >= rejection.order || previous.parentRound !== 1 || rejection.parentRound !== 1) return false;
  if (parent.children.list(model).length > modelRegenerationDeclaration.maxAdditionalCalls) return false;
  if (previous.returned?.status !== 'succeeded' || previous.reception.status !== 'accepted') return false;
  if (rejection.returned?.status !== 'failed' || rejection.returned.failure?.kind !== 'exception' || rejection.returned.failure.contract !== modelOutputRejected.name || rejection.reception.status !== 'pending') return false;
  if (parent.round === 2 && (parent.continuation?.stage !== 'handling' || parent.continuation.origin?.kind !== 'child-return' || parent.continuation.origin.child !== rejection.ref)) return false;
  const diagnostic = rejectionDiagnostic.safeParse(rejection.returned.diagnostic);
  if (!diagnostic.success) return false;
  const acceptance = rejection.input;
  if (!isObject(acceptance) || !isEqual(acceptance.output, previous.returned.output)) return false;
  return previous.returned.output.finishReason === 'stop';
}

export function modelRegenerationInput(parent: ModelParentFacts, evidence: ModelRegenerationEvidence, model: RequestModelDefinition): ModelRegenerationInput {
  if (!allowsModelRegeneration(parent, evidence, model)) throw new RuntimeError('MODEL_REGENERATION_NOT_ALLOWED', '本次模型调用不满足再次生成的声明与条件。');
  const previous = parent.children.require(model, evidence.previous);
  const rejection = parent.children.get(evidence.rejection);
  if (previous.returned?.status !== 'succeeded' || rejection.returned?.status !== 'failed') throw new Error('Regeneration evidence changed');
  const diagnostic = rejectionDiagnostic.parse(rejection.returned.diagnostic);
  return { request: previous.input, output: previous.returned.output, error: { code: diagnostic.detail.code, message: diagnostic.message } };
}

export function prepareRegenerationRequest(input: ModelRegenerationInput): ModelRequest {
  return {
    ...input.request,
    messages: [...input.request.messages, { role: 'assistant', content: input.output.content }, { role: 'user', content: `上一次返回未通过输出契约检查：${input.error.code}，${input.error.message}\n请依据原始请求重新生成完整 JSON，严格遵守原有 Schema，不添加解释或代码围栏。` }],
  };
}
