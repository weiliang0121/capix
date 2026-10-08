import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../observer/resources.js';
import { InvocationEntry, AttemptDefinition, type AttemptContext, RuntimeError } from '@capix-observer/runtime';

import { allowsModelRegeneration, modelRegenerationDeclaration, modelRegenerationInput, prepareRegenerationRequest, type ModelParent, type ModelRegenerationEvidence } from '../../model/regeneration.js';
import { isEqual } from 'es-toolkit/predicate';
import { checkCapacity } from '../../model/capacity.js';

import type { ModelRequest, ModelOutput, Purpose } from '../../model/types.js';

export class InvokeModel extends AttemptDefinition<ModelRequest, ModelOutput, ModelCallResources> {
  static readonly requires = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), model: ModelResource.invoke.request() });

  readonly requires = InvokeModel.requires;

  readonly name = 'invokeModel';
  readonly label = '调用模型';
  readonly source = 'services/observer/src/attempt/model/invoke.ts · InvokeModel';
  readonly callee = 'provider';

  readonly regeneration = Object.freeze({
    declaration: modelRegenerationDeclaration,
    requires: this.requires,
    allows: (parent: ModelParent, evidence: ModelRegenerationEvidence) => allowsModelRegeneration(parent, evidence),
    entry: new InvocationEntry<InvokeModel, { request: ModelRequest; evidence: ModelRegenerationEvidence }>(this, (parent: ModelParent, input: { request: ModelRequest; evidence: ModelRegenerationEvidence }, options) => {
      const evidence = modelRegenerationInput(parent, input.evidence);
      if (options.key !== input.evidence.previous.key || !isEqual(input.request, prepareRegenerationRequest(evidence))) throw new RuntimeError('MODEL_REGENERATION_NOT_ALLOWED', '再次生成必须保留原请求与对应的错误反馈。');
      return input.request;
    }),
  });

  constructor(private readonly purpose: Purpose) {
    super();
  }

  execute(context: AttemptContext<ModelRequest, ModelOutput, ModelCallResources>): Promise<ModelOutput> {
    const { timeoutMs, settings, model } = context.resources.values;
    checkCapacity(context.currentInput, settings);
    return model.invoke(context.currentInput, this.purpose, AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]));
  }
}
