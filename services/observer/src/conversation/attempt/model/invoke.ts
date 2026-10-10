import { invocationRecording } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { InvocationEntry, AttemptDefinition, type AttemptContextView, RuntimeError } from '@capix/server-runtime';

import { allowsModelRegeneration, modelRegenerationDeclaration, modelRegenerationInput, prepareRegenerationRequest, type ModelParentInvocationView, type ModelRegenerationEvidence } from '../../model/regeneration.js';
import { isEqual } from 'es-toolkit/predicate';
import { checkCapacity } from '../../model/capacity.js';

import type { ModelRequest, ModelOutput, Purpose } from '../../model/types.js';

export class InvokeModelDefinition extends AttemptDefinition<ModelRequest, ModelOutput, ModelCallResources> {
  readonly observation = [invocationRecording()];
  static readonly requires = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), model: ModelResource.invoke.request() });

  readonly run = { requires: InvokeModelDefinition.requires, execute: this.execute.bind(this) };

  readonly name = 'invokeModel';
  readonly label = '调用模型';
  readonly source = 'services/observer/src/conversation/attempt/model/invoke.ts · InvokeModelDefinition';
  readonly callee = 'provider';

  readonly regeneration = Object.freeze({
    declaration: modelRegenerationDeclaration,
    requires: this.run.requires,
    allows: (parent: ModelParentInvocationView, evidence: ModelRegenerationEvidence) => allowsModelRegeneration(parent, evidence),
    entry: new InvocationEntry<InvokeModelDefinition, { request: ModelRequest; evidence: ModelRegenerationEvidence }>(this, (parent: ModelParentInvocationView, input: { request: ModelRequest; evidence: ModelRegenerationEvidence }, options) => {
      const evidence = modelRegenerationInput(parent, input.evidence);
      if (options.key !== input.evidence.previous.key || !isEqual(input.request, prepareRegenerationRequest(evidence))) throw new RuntimeError('MODEL_REGENERATION_NOT_ALLOWED', '再次生成必须保留原请求与对应的错误反馈。');
      return input.request;
    }),
  });

  constructor(private readonly purpose: Purpose) {
    super();
  }

  private execute(context: AttemptContextView<ModelRequest, ModelOutput, ModelCallResources>): Promise<ModelOutput> {
    const { timeoutMs, settings, model } = context.resources.values;
    checkCapacity(context.currentInput, settings);
    return model.invoke(context.currentInput, this.purpose, AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]));
  }
}
