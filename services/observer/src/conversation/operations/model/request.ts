import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { InvocationEntry, OperationDefinition, RuntimeError, type OperationContextView, type InvocationWorkView, type ChildBindings } from '@capix/server-runtime';
import { allowsModelRegeneration, modelRegenerationDeclaration, modelRegenerationInput, prepareRegenerationRequest, type ModelParentInvocationView, type ModelRegenerationEvidence } from '../../model/regeneration.js';
import { isEqual } from 'es-toolkit/predicate';
import type { ModelRequest, ModelOutput, Purpose, ModelTextDelta } from '../../model/types.js';
import { InvokeModelDefinition } from '../../attempt/model/invoke.js';
import { FollowModelDefinition } from '../../attempt/model/follow.js';

/** One external request with bounded local waits; following never regenerates or resends. */
export class RequestModelDefinition extends OperationDefinition<ModelRequest, ModelOutput, ModelCallResources, Record<string, never>, ModelTextDelta> {
  readonly output = {
    result: (value: unknown) => value as ModelOutput,
    delta: (value: unknown): ModelTextDelta => {
      if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' || !value.text.length) throw new TypeError('Model text delta required');
      return value as ModelTextDelta;
    },
  };
  readonly name = 'requestModel';
  readonly label = '请求模型';
  readonly source = 'services/observer/src/conversation/operations/model/request.ts · RequestModelDefinition';
  readonly observation;
  readonly invokeDefinition;
  readonly followDefinition = new FollowModelDefinition();
  readonly children;
  static readonly requires = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() });
  readonly run;
  readonly regeneration = Object.freeze({
    declaration: modelRegenerationDeclaration,
    requires: RequestModelDefinition.requires,
    allows: (parent: ModelParentInvocationView, evidence: ModelRegenerationEvidence) => allowsModelRegeneration(parent, evidence),
    entry: new InvocationEntry<RequestModelDefinition, { request: ModelRequest; evidence: ModelRegenerationEvidence }>(this, (parent: ModelParentInvocationView, input: { request: ModelRequest; evidence: ModelRegenerationEvidence }, options) => {
      const evidence = modelRegenerationInput(parent, input.evidence);
      if (options.key !== input.evidence.previous.key || !isEqual(input.request, prepareRegenerationRequest(evidence))) throw new RuntimeError('MODEL_REGENERATION_NOT_ALLOWED', '再次生成必须保留原请求与对应的错误反馈。');
      return input.request;
    }),
  });

  constructor(purpose: Purpose, description: InvocationRecordDescription<ModelRequest, ModelOutput> = {}) {
    super();
    this.observation = [invocationRecording(description)];
    this.invokeDefinition = new InvokeModelDefinition(purpose, description);
    this.children = Object.freeze([this.invokeDefinition, this.followDefinition]);
    this.run = { requires: RequestModelDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationContextView<ModelRequest, ModelOutput, ModelCallResources>, invocation: InvocationWorkView<ModelRequest, ModelOutput, OperationContextView<ModelRequest, ModelOutput, ModelCallResources>, ModelTextDelta>, children: ChildBindings): Promise<ModelOutput> {
    let detach = () => {};
    const initial = children.get(this.invokeDefinition).create(invocation, context.currentInput, {
      key: 'start',
      output: {
        receive: (event): undefined => {
          if (event.kind === 'delta' && context.currentInput.stream)
            detach = context.resources.values.modelReader.subscribe(event.delta, {
              receive: (delta): undefined => {
                invocation.output.emit(delta);
              },
            });
        },
      },
    });
    try {
      await initial.run();
      const result = await children.accept(initial, (delivered) => delivered);
      if (result.kind === 'received') return result.output;
      const follow = children.get(this.followDefinition).create(invocation, result.interaction, { key: 'follow' });
      await follow.run();
      return await children.accept(follow, (delivered) => delivered);
    } finally {
      detach();
    }
  }
}
