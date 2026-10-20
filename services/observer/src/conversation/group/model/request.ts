import { invocationRecording, type InvocationRecordDescription } from '@capix/server-runtime/recording';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { defineChildEntry, Group, RuntimeError, checkpointPoint, childReference, childReferences, type GroupWork, type ResumeWork, type ChildReference, type CheckpointFacts, type ChildFact, type ChildrenOf } from '@capix/server-runtime';
import { allowsModelRegeneration, modelRegenerationDeclaration, modelRegenerationInput, prepareRegenerationRequest, type ModelParentFacts, type ModelRegenerationEvidence } from '../../model/regeneration.js';
import { isEqual } from 'es-toolkit/predicate';
import type { ModelRequest, ModelOutput, Purpose, ModelTextDelta } from '../../model/types.js';
import { InvokeModel } from '../../node/model/invoke.js';
import { FollowModel } from '../../node/model/follow.js';
import { modelRequestCodec as requestCodec, modelFeedbackCodec as outputCodec } from '../../model/checkpoint.js';
import { checkpointCodec } from '../../checkpoint.js';
import { z } from 'zod';

type ModelWork = GroupWork<ModelRequest, ModelOutput, object, ChildrenOf<'group'>, ModelTextDelta> | ResumeWork<'group', ModelRequest, ModelOutput, object, ChildrenOf<'group'>, ModelTextDelta>;
const emptyState = checkpointCodec(z.strictObject({}));

/** One external request with bounded local waits; following never regenerates or resends. */
export class RequestModel extends Group<ModelRequest, ModelOutput, ModelCallResources, Record<string, never>, ModelTextDelta> {
  readonly invokeModel;
  readonly followModel;

  readonly startWaiting;
  readonly followWaiting;
  readonly feedbackAccepted;
  static readonly requires = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() });

  readonly regeneration;

  constructor(
    private readonly purpose: Purpose,
    description: InvocationRecordDescription<ModelRequest, ModelOutput> = {},
  ) {
    super();

    this.followModel = new FollowModel();
    this.regeneration = Object.freeze({
      declaration: modelRegenerationDeclaration,
      requires: RequestModel.requires,
      allows: (parent: ModelParentFacts, evidence: ModelRegenerationEvidence) => allowsModelRegeneration(parent, evidence, this),
      input: (parent: ModelParentFacts, evidence: ModelRegenerationEvidence) => modelRegenerationInput(parent, evidence, this),
      entry: defineChildEntry<RequestModel, { request: ModelRequest; evidence: ModelRegenerationEvidence }>(this, {
        accept: ({ input, facts, key }) => {
          const evidence = modelRegenerationInput(facts, input.evidence, this);
          const previous = facts.children.require(this, input.evidence.previous);
          if (key !== previous.key || !isEqual(input.request, prepareRegenerationRequest(evidence))) throw new RuntimeError('MODEL_REGENERATION_NOT_ALLOWED', '再次生成必须保留原请求与对应的错误反馈。');
          return input.request;
        },
      }),
    });

    this.invokeModel = new InvokeModel(purpose, description);
    this.add(this.invokeModel, this.followModel);
    const point = checkpointPoint<'group', ModelRequest, ModelOutput, ModelTextDelta>();
    this.startWaiting = point({
      name: 'startWaiting',
      state: emptyState,
      references: { start: childReference(this.invokeModel) },
      check: (_state, facts) => {
        originalRequest(facts);
        const child = facts.references.start;
        if (facts.children.values().length !== 1 || child.returned || !isEqual(child.input, facts.input)) throw new Error('Model start checkpoint changed request');
      },
      resume: {
        requires: {},
        uses: this.members,
        execute: async (work, _state, saved) => {
          const initial = work.children.resume(saved.start);
          await initial.run();
          return this.receiveInitial(work, await initial.accept(), initial.ref);
        },
      },
    });
    this.followWaiting = point({
      name: 'followWaiting',
      state: emptyState,
      references: { start: childReference(this.invokeModel), follow: childReference(this.followModel) },
      check: (_state, facts) => {
        originalRequest(facts);
        const result = acceptedOutput(facts.references.start);
        const follow = facts.references.follow;
        if (facts.children.values().length !== 2 || result.kind !== 'pending' || follow.returned || !isEqual(follow.input, { ...result.interaction, expected: { request: facts.input, purpose: this.purpose } })) throw new Error('Model follow checkpoint changed interaction');
      },
      resume: {
        requires: {},
        uses: [this.followModel],
        execute: async (work, _state, saved) => {
          const follow = work.children.resume(saved.follow);
          await follow.run();
          const output = await follow.accept();
          work.checkpoint?.save(this.feedbackAccepted, output, { start: saved.start, follow: [follow.ref] });
          return output;
        },
      },
    });
    this.feedbackAccepted = point({
      name: 'feedbackAccepted',
      state: outputCodec,
      references: { start: childReference(this.invokeModel), follow: childReferences(this.followModel) },
      check: (output, facts) => {
        originalRequest(facts);
        const initial = facts.references.start;
        const result = acceptedOutput(initial);
        if (!isEqual(initial.input, facts.input)) throw new Error('Model feedback checkpoint changed its original request');
        if (result.kind === 'received') {
          if (facts.children.values().length !== 1 || facts.references.follow.length || !isEqual(result.output, output)) throw new Error('Model feedback checkpoint differs from direct feedback');
        } else {
          const follow = facts.references.follow[0];
          if (facts.children.values().length !== 2 || facts.references.follow.length !== 1 || !follow || !isEqual(follow.input, { ...result.interaction, expected: { request: facts.input, purpose: this.purpose } }) || !isEqual(acceptedOutput(follow), output)) throw new Error('Model feedback checkpoint differs from followed feedback');
        }
      },
      resume: { requires: {}, uses: [], execute: (_work, output) => output },
    });

    this.setDefinition({
      output: {
        result: (value: unknown) => value as ModelOutput,
        delta: (value: unknown): ModelTextDelta => {
          if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' || !value.text.length) throw new TypeError('Model text delta required');
          return value as ModelTextDelta;
        },
      },
      name: 'requestModel',
      label: '请求模型',
      source: 'services/observer/src/conversation/group/model/request.ts · RequestModel',
      observation: [invocationRecording(description)],
      checkpoint: { key: `observer.request-model.${purpose}`, version: 3, input: requestCodec, output: outputCodec, points: [this.startWaiting, this.followWaiting, this.feedbackAccepted] },
      run: { requires: RequestModel.requires, uses: this.members, execute: this.execute.bind(this) },
    });
  }

  private async execute(work: GroupWork<ModelRequest, ModelOutput, ModelCallResources, ChildrenOf<'group'>, ModelTextDelta>): Promise<ModelOutput> {
    let detach = () => {};
    const initial = work.children.create(this.invokeModel, work.input, {
      key: 'start',
      output: {
        receive: (event): undefined => {
          if (event.kind === 'delta' && work.input.stream)
            detach = work.resources.modelReader.subscribe(event.delta, {
              receive: (delta): undefined => {
                work.output.emit(delta);
              },
            });
        },
      },
    });
    work.checkpoint?.save(this.startWaiting, {}, { start: initial.ref });
    try {
      await initial.run();
      return await this.receiveInitial(work, await initial.accept(), initial.ref);
    } finally {
      detach();
    }
  }

  private async receiveInitial(work: ModelWork, result: import('../../model/interactions.js').ModelInteractionResult, initial: ChildReference<InvokeModel>): Promise<ModelOutput> {
    let output: ModelOutput;
    const followed: ChildReference<FollowModel>[] = [];
    if (result.kind === 'received') output = result.output;
    else {
      const follow = work.children.create(this.followModel, { ...result.interaction, expected: { request: work.input, purpose: this.purpose } }, { key: 'follow' });
      work.checkpoint?.save(this.followWaiting, {}, { start: initial, follow: follow.ref });
      await follow.run();
      output = await follow.accept();
      followed.push(follow.ref);
    }
    work.checkpoint?.save(this.feedbackAccepted, output, { start: initial, follow: followed });
    return output;
  }
}

function originalRequest(facts: CheckpointFacts<ModelRequest>): void {
  if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input)) throw new Error('Model feedback checkpoint must preserve its original request');
}

function acceptedOutput<D extends InvokeModel | FollowModel>(child: ChildFact<D>): import('@capix/server-runtime').CallableOutput<D> {
  if (child.parentRound !== 1 || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isEqual(child.returned.output, child.reception.value)) throw new Error('Model feedback checkpoint requires a returned and accepted child');
  return child.returned.output;
}
