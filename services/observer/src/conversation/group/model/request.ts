import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import type { ModelCallResources } from '../../resources.js';
import { Group, checkpointPoint, childReference, childReferences, type GroupWork, type ResumeWork, type ChildReference, type CheckpointFacts, type ChildFact, type ChildrenOf } from '@capix/structure';
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
export class RequestModel extends Group<ModelRequest, ModelOutput, ModelCallResources, ModelTextDelta> {
  readonly invokeModel;
  readonly followModel;

  readonly startWaiting;
  readonly followWaiting;
  readonly feedbackAccepted;
  static readonly deps = Object.freeze({ timeoutMs: ModelSettingsResource.timeout.request(), settings: ModelSettingsResource.snapshot.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() });

  constructor(private readonly purpose: Purpose) {
    super();

    this.followModel = new FollowModel();

    this.invokeModel = new InvokeModel(purpose);
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
        deps: {},
        uses: this.members,
        run: async (work, _state, saved) => {
          const initial = work.children.resume(saved.start);

          return this.receiveInitial(work, await initial.invoke(), initial.ref);
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
        deps: {},
        uses: [this.followModel],
        run: async (work, _state, saved) => {
          const follow = work.children.resume(saved.follow);

          const output = await follow.invoke();
          work.checkpoint?.({ point: this.feedbackAccepted, state: output, refs: { start: saved.start, follow: [follow.ref] } });
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
      resume: { deps: {}, uses: [], run: (_work, output) => output },
    });

    this.output = {
      result: (value: unknown) => value as ModelOutput,
      delta: (value: unknown): ModelTextDelta => {
        if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' || !value.text.length) throw new TypeError('Model text delta required');
        return value as ModelTextDelta;
      },
    };
    this.name = 'requestModel';
    this.label = '请求模型';
    this.source = 'services/observer/src/conversation/group/model/request.ts · RequestModel';
    this.checkpoint = { key: `observer.request-model.${purpose}`, version: 3, input: requestCodec, output: outputCodec, points: [this.startWaiting, this.followWaiting, this.feedbackAccepted] };
    this.deps = RequestModel.deps;
    this.run = this.execute.bind(this);
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
    work.checkpoint?.({ point: this.startWaiting, state: {}, refs: { start: initial.ref } });
    try {
      return await this.receiveInitial(work, await initial.invoke(), initial.ref);
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
      work.checkpoint?.({ point: this.followWaiting, state: {}, refs: { start: initial, follow: follow.ref } });

      output = await follow.invoke();
      followed.push(follow.ref);
    }
    work.checkpoint?.({ point: this.feedbackAccepted, state: output, refs: { start: initial, follow: followed } });
    return output;
  }
}

function originalRequest(facts: CheckpointFacts<ModelRequest>): void {
  if (facts.round !== 1 || !isEqual(facts.initialInput, facts.input)) throw new Error('Model feedback checkpoint must preserve its original request');
}

function acceptedOutput<D extends InvokeModel | FollowModel>(child: ChildFact<D>): Stable<import('@capix/server-runtime').CallableOutput<D>> {
  if (child.parentRound !== 1 || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isEqual(child.returned.output, child.reception.value)) throw new Error('Model feedback checkpoint requires a returned and accepted child');
  return child.returned.output;
}
import type { Stable } from '@capix/contracts';
