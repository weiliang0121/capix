import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { InvocationEntry, OperationDefinition, RuntimeError, type OperationContextView, type InvocationWorkView, type ChildBindings, type InvocationCheckpointDefinition, type InvocationCheckpointFrame, type CheckpointChild } from '@capix/server-runtime';
import { allowsModelRegeneration, modelRegenerationDeclaration, modelRegenerationInput, prepareRegenerationRequest, type ModelParentInvocationView, type ModelRegenerationEvidence } from '../../model/regeneration.js';
import { isEqual } from 'es-toolkit/predicate';
import type { ModelRequest, ModelOutput, Purpose, ModelTextDelta } from '../../model/types.js';
import { InvokeModelDefinition } from '../../attempt/model/invoke.js';
import { FollowModelDefinition } from '../../attempt/model/follow.js';
import { childWaitingCodec, waitingChild, originalCheckpoint } from '../checkpoint.js';
import { modelRequestCodec as requestCodec, modelFeedbackCodec as outputCodec } from '../../model/checkpoint.js';

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
  readonly checkpoint: InvocationCheckpointDefinition<ModelRequest, ModelOutput, OperationContextView<ModelRequest, ModelOutput, ModelCallResources>, ModelTextDelta>;
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

  constructor(
    private readonly purpose: Purpose,
    description: InvocationRecordDescription<ModelRequest, ModelOutput> = {},
  ) {
    super();
    this.observation = [invocationRecording(description)];
    this.invokeDefinition = new InvokeModelDefinition(purpose, description);
    this.children = Object.freeze([this.invokeDefinition, this.followDefinition]);
    this.checkpoint = {
      key: `observer.request-model.${purpose}`,
      version: 2,
      input: requestCodec,
      output: outputCodec,
      points: {
        startWaiting: {
          state: childWaitingCodec,
          check: (frame, state) => {
            originalCheckpoint(frame);
            const child = waitingChild(frame, state, 'start', this.invokeDefinition.checkpoint);
            if (frame.children.length !== 1 || !isEqual(child.input, frame.currentInput)) throw new Error('Model start checkpoint changed request');
          },
          resume: {
            requires: {},
            uses: this.children,
            execute: async (_context, invocation, children, state: { childId: string }) => {
              const initial = children.get(this.invokeDefinition).resume(invocation, state.childId);
              await initial.run();
              return this.receiveInitial(invocation, children, await children.accept(initial, (value) => value));
            },
          },
        },
        followWaiting: {
          state: childWaitingCodec,
          check: (frame, state) => {
            originalCheckpoint(frame);
            const child = waitingChild(frame, state, 'follow', this.followDefinition.checkpoint);
            const initial = frame.children[0];
            const result = initial && acceptedOutput(initial);
            if (frame.children.length !== 2 || !result || typeof result !== 'object' || !('kind' in result) || result.kind !== 'pending' || !('interaction' in result) || !isEqual(child.input, { ...(result.interaction as { id: string }), expected: { request: frame.currentInput, purpose: this.purpose } })) throw new Error('Model follow checkpoint changed interaction');
          },
          resume: {
            requires: {},
            uses: [this.followDefinition],
            execute: async (_context, invocation, children, state: { childId: string }) => {
              const follow = children.get(this.followDefinition).resume(invocation, state.childId);
              await follow.run();
              const output = await children.accept(follow, (value) => value);
              invocation.checkpoint?.save('feedbackAccepted', output);
              return output;
            },
          },
        },
        feedbackAccepted: {
          state: outputCodec,
          check: (frame, output) => checkAcceptedFeedback(frame, output, this.purpose),
          resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, output: ModelOutput) => output },
        },
      },
    };
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
    invocation.checkpoint?.save('startWaiting', { childId: initial.context.id });
    try {
      await initial.run();
      return this.receiveInitial(invocation, children, await children.accept(initial, (delivered) => delivered));
    } finally {
      detach();
    }
  }
  private async receiveInitial(invocation: InvocationWorkView<ModelRequest, ModelOutput, OperationContextView<ModelRequest, ModelOutput, any>, ModelTextDelta>, children: ChildBindings, result: import('../../model/interactions.js').ModelInteractionResult): Promise<ModelOutput> {
    let output: ModelOutput;
    if (result.kind === 'received') output = result.output;
    else {
      const follow = children.get(this.followDefinition).create(invocation, { ...result.interaction, expected: { request: invocation.context.currentInput, purpose: this.purpose } }, { key: 'follow' });
      invocation.checkpoint?.save('followWaiting', { childId: follow.context.id });
      await follow.run();
      output = await children.accept(follow, (delivered) => delivered);
    }
    invocation.checkpoint?.save('feedbackAccepted', output);
    return output;
  }
}

/** Provider feedback was received by this O; business JSON acceptance remains the parent's work. */
function checkAcceptedFeedback(frame: InvocationCheckpointFrame, output: ModelOutput, purpose: Purpose): void {
  if (frame.round !== 1 || !isEqual(frame.input, frame.currentInput)) throw new Error('Model feedback checkpoint must preserve its original request');
  const initial = frame.children[0];
  if (!initial || initial.key !== 'start' || !isEqual(initial.input, frame.currentInput)) throw new Error('Model feedback checkpoint requires its original start call');
  const result = acceptedOutput(initial);
  if (!result || typeof result !== 'object' || Array.isArray(result) || !('kind' in result)) throw new Error('Model feedback checkpoint has no accepted interaction result');
  if (result.kind === 'received') {
    if (frame.children.length !== 1 || !('output' in result) || !isEqual(result.output, output)) throw new Error('Model feedback checkpoint does not match accepted direct feedback');
    return;
  }
  const follow = frame.children[1];
  if (result.kind !== 'pending' || !('interaction' in result) || frame.children.length !== 2 || !follow || follow.key !== 'follow' || !isEqual(follow.input, { ...(result.interaction as { id: string }), expected: { request: frame.currentInput, purpose } }) || !isEqual(acceptedOutput(follow), output)) throw new Error('Model feedback checkpoint does not match the followed interaction');
}

function acceptedOutput(child: CheckpointChild) {
  if (child.identity.level !== 'attempt' || child.round !== 1 || child.state.kind !== 'returned' || child.state.reception.kind !== 'accepted' || !isEqual(child.state.output, child.state.reception.output)) throw new Error('Model feedback checkpoint requires a returned and accepted child');
  return child.state.output;
}
