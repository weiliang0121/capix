import { Group, checkpointPoint, childReference, type ChildCall, type ChildrenOf, type GroupWork, type ResumeWork, type CheckpointFacts } from '@capix/structure';
import type { GenerationOutput } from '@capix/protocol';
import { isEqual } from 'es-toolkit/predicate';
import { RequestModel } from '../model/request.js';
import { AcceptModelOutput, type ModelAcceptanceInput } from '../../node/model/accept.js';
import type { ModelRequest, ModelOutput } from '../../model/types.js';
import type { ModelCallResources } from '../../resources.js';
import { modelRequestCodec } from '../../model/checkpoint.js';
import { answerOutputContract } from './output.js';
import { answerStream, AnswerTextDecoder, type AnswerTextDelta } from './stream.js';
import { answerCheckpointCodecs } from './checkpoint.js';

type Work = GroupWork<ModelRequest, GenerationOutput, object, ChildrenOf<'group'>, AnswerTextDelta> | ResumeWork<'group', ModelRequest, GenerationOutput, object, ChildrenOf<'group'>, AnswerTextDelta>;

/** One candidate owns one output segment. Rejection ends it; another candidate is a new call. */
export class GenerateAnswerCandidate extends Group<ModelRequest, GenerationOutput, ModelCallResources, AnswerTextDelta> {
  readonly requestModel = new RequestModel('answer');
  readonly acceptOutput = new AcceptModelOutput(answerOutputContract);
  readonly modelWaiting;
  readonly acceptanceWaiting;
  readonly answerAccepted;

  constructor() {
    super();
    this.add(this.requestModel, this.acceptOutput);
    const point = checkpointPoint<'group', ModelRequest, GenerationOutput, AnswerTextDelta>();
    this.modelWaiting = point({
      name: 'modelWaiting',
      state: answerCheckpointCodecs.waiting,
      references: { model: childReference(this.requestModel) },
      check: (_state, facts) => {
        this.original(facts);
        const model = facts.references.model;
        if (facts.children.values().length !== 1 || model.returned || model.key !== 'model' || !isEqual(model.input, facts.input)) throw new Error('Candidate model checkpoint changed its fixed request');
      },
      resume: { uses: [this.requestModel, this.acceptOutput], run: (work, _state, saved) => this.receiveModel(work, work.children.resume(saved.model)) },
    });
    this.acceptanceWaiting = point({
      name: 'acceptanceWaiting',
      state: answerCheckpointCodecs.waiting,
      references: { acceptance: childReference(this.acceptOutput) },
      check: (_state, facts) => {
        const model = this.model(facts);
        const acceptance = facts.references.acceptance;
        if (facts.children.values().length !== 2 || acceptance.returned || acceptance.key !== 'acceptance' || !isEqual(acceptance.input, { output: model })) throw new Error('Candidate acceptance checkpoint changed its model feedback');
      },
      resume: { uses: [this.acceptOutput], run: (work, _state, saved) => this.receiveAcceptance(work, work.children.resume(saved.acceptance)) },
    });
    this.answerAccepted = point({
      name: 'answerAccepted',
      state: answerCheckpointCodecs.output,
      references: { acceptance: childReference(this.acceptOutput) },
      check: (answer, facts) => {
        const model = this.model(facts);
        const accepted = facts.references.acceptance;
        if (facts.children.values().length !== 2 || accepted.returned?.status !== 'succeeded' || accepted.reception.status !== 'accepted' || accepted.key !== 'acceptance' || !isEqual(accepted.input, { output: model }) || !isEqual(accepted.returned.output, answer) || !isEqual(accepted.reception.value, answer)) throw new Error('Candidate checkpoint differs from its accepted answer');
        if (model.finishReason !== 'stop' || !isEqual(answerOutputContract.accept(JSON.parse(model.content)), answer)) throw new Error('Candidate answer is not a complete model result');
      },
      resume: { run: (_work, answer) => answer },
    });
    this.name = 'answerCandidate';
    this.label = '生成回答候选';
    this.source = 'services/observer/src/conversation/group/answer/candidate.ts · GenerateAnswerCandidate';
    this.deps = RequestModel.deps;
    this.output = answerStream;
    this.run = this.execute.bind(this);
    this.checkpoint = { key: 'observer.answer-candidate', version: 1, input: modelRequestCodec, output: answerCheckpointCodecs.output, points: [this.modelWaiting, this.acceptanceWaiting, this.answerAccepted] };
  }

  private async execute(work: Work): Promise<GenerationOutput> {
    const decoder = new AnswerTextDecoder();
    const model = work.children.create(this.requestModel, work.input, {
      key: 'model',
      output: {
        receive(event) {
          if (event.kind !== 'delta') return;
          const text = decoder.push(event.delta.text);
          if (text) work.output.emit({ text });
        },
      },
    });
    work.checkpoint?.({ point: this.modelWaiting, state: {}, refs: { model: model.ref } });
    return this.receiveModel(work, model);
  }

  private async receiveModel(work: Work, model: ChildCall<RequestModel>): Promise<GenerationOutput> {
    const output = await model.invoke();
    const acceptance = work.children.create(this.acceptOutput, { output }, { key: 'acceptance' });
    work.checkpoint?.({ point: this.acceptanceWaiting, state: {}, refs: { acceptance: acceptance.ref } });
    return this.receiveAcceptance(work, acceptance);
  }

  private async receiveAcceptance(work: Work, acceptance: ChildCall<AcceptModelOutput<ModelAcceptanceInput, GenerationOutput>>): Promise<GenerationOutput> {
    const answer = await acceptance.invoke();
    work.checkpoint?.({ point: this.answerAccepted, state: answer, refs: { acceptance: acceptance.ref } });
    return answer;
  }

  private original(facts: CheckpointFacts<ModelRequest>): void {
    if (facts.round !== 1 || !isEqual(facts.input, facts.initialInput)) throw new Error('Candidate checkpoint must preserve its original request');
  }

  private model(facts: CheckpointFacts<ModelRequest>): ModelOutput {
    this.original(facts);
    const model = facts.children.requireUnique(this.requestModel, { parentRound: 1 });
    if (model.key !== 'model' || !isEqual(model.input, facts.input) || model.returned?.status !== 'succeeded' || model.reception.status !== 'accepted' || !isEqual(model.returned.output, model.reception.value)) throw new Error('Candidate checkpoint requires its accepted model feedback');
    return model.returned.output;
  }
}
