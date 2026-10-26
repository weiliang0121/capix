import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { checkpointCodec } from '../../checkpoint.js';
import { selectionInputCodec, selectionCodec, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { TranscriptResource } from '@capix/transcript';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ConversationResources, type ModelRequestResources, type HistoryResources } from '../../resources.js';
import { checkpointPoint, childReference, type GroupWork, type ChildCall } from '@capix/structure';
import type { ModelSettings } from '@capix/protocol';
import type { Selection } from '../../model/types.js';
import { Group } from '@capix/structure';
import { type TranscriptRangeReader } from '@capix/transcript';
import { historyMessages, type SelectionInput } from './input.js';
import { selectionOutputContract, type SelectionBasis } from './output.js';

import { PrepareModelRequest } from '../../node/model/prepare.js';
import { RequestModel } from '../model/request.js';
import { AcceptModelOutput, type ModelAcceptanceInput } from '../../node/model/accept.js';

import { loadRequest } from '../../model/request.js';
import { estimateCapacity } from '../../model/capacity.js';

const selectionTask = `结合 memories 中的已有理解和 history 中的可见原文，为回答当前 message 选择充分且相关的历史依据。关注指代、仍有效的条件，以及能补充或修正已有理解的信息；由你判断需要哪些原文，不只按关键词匹配。
history 仅覆盖当前消息段，memories 可能保留旧段理解，但不保证正确，也不代表其来源原文可见。sourceResults 中的 file-created 是系统接纳的历史创建凭据，不保证文件当前仍存在或正文未变。historyIndexes 只能选自 history，按相关性与必要性从高到低排列，不重复；无需原文时返回空数组。不生成回答。`;

const selectionRequestResources = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request() });

export class SelectHistory extends Group<SelectionInput, Selection, ConversationResources> {
  protected readonly purpose: 'selection';
  protected readonly outputContract;

  static readonly deps = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), timeoutMs: ModelSettingsResource.timeout.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() } as const);

  readonly points;

  readonly prepareRequest: PrepareModelRequest<SelectionInput, ModelRequestResources & HistoryResources>;
  readonly requestModel: RequestModel;
  readonly acceptOutput: AcceptModelOutput<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>;

  constructor() {
    super();

    this.purpose = 'selection';
    this.outputContract = selectionOutputContract;
    this.prepareRequest = new PrepareModelRequest<SelectionInput, ModelRequestResources & HistoryResources>((input, resources) => loadRequest(selectionPayload(input, historyMessages(resources.history, input.message)), selectionTask, this.outputContract.schema, resources.settings), selectionRequestResources);
    this.requestModel = new RequestModel(this.purpose);
    this.acceptOutput = new AcceptModelOutput({ schema: this.outputContract.schema, accept: (value, input: ModelAcceptanceInput & { basis: SelectionBasis }) => this.outputContract.accept(value, input.basis) });
    this.add(this.prepareRequest, this.requestModel, this.acceptOutput);
    const point = checkpointPoint<'group', SelectionInput, Selection>();
    const basisCodec = checkpointCodec(z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() }));
    this.points = {
      requestWaiting: point({
        name: 'requestWaiting',
        state: basisCodec,
        references: { child: childReference(this.prepareRequest) },
        check: (basis, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'request');
          if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input) || basis.end < basis.start) throw new Error('Selection preparation checkpoint changed input');
        },
        resume: { uses: this.members, run: (work, basis, saved) => this.receiveRequest(work, work.children.resume(saved.child), basis) },
      }),
      acceptanceWaiting: point({
        name: 'acceptanceWaiting',
        state: emptyCheckpointState,
        references: { child: childReference(this.acceptOutput) },
        check: (_state, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'acceptance');
          const model = acceptedChild(facts.children.requireUnique(this.requestModel, { parentRound: 1 }));
          if (facts.children.values().length !== 3 || model.key !== 'model' || !isEqual(child.input.output, model.reception.value)) throw new Error('Selection acceptance checkpoint changed feedback');
        },
        resume: { uses: [this.acceptOutput], run: (work, _state, saved) => this.receiveAcceptance(work, work.children.resume(saved.child)) },
      }),
      modelWaiting: point({
        name: 'modelWaiting',
        state: basisCodec,
        references: { child: childReference(this.requestModel) },
        check: (basis, facts) => {
          originalCheckpoint(facts);
          const model = waitingChild(facts, facts.references.child, 'model');
          const request = acceptedChild(facts.children.requireUnique(this.prepareRequest, { parentRound: 1 }));
          if (facts.children.values().length !== 2 || request.key !== 'request' || !isEqual(request.input, facts.input) || !isEqual(model.input, request.reception.value) || basis.end < basis.start) throw new Error('Selection checkpoint differs from prepared model request');
        },
        resume: { uses: [this.requestModel, this.acceptOutput], run: (work, basis, saved) => this.receiveModel(work, work.children.resume(saved.child), basis) },
      }),
      result: point({
        name: 'result',
        state: selectionCodec,
        references: {},
        check: (output, facts) => {
          originalCheckpoint(facts);
          const accepted = acceptedChild(facts.children.requireUnique(this.acceptOutput, { parentRound: 1 }));
          if (accepted.key !== 'acceptance' || !isEqual(accepted.reception.value, output)) throw new Error('Selection checkpoint differs from accepted result');
        },
        resume: { run: (_work, output) => output },
      }),
    };

    this.name = 'selection';
    this.label = '选择历史';
    this.source = 'services/observer/src/conversation/group/history/select.ts · SelectHistory';
    this.deps = SelectHistory.deps;
    this.run = this.execute.bind(this);
    this.checkpoint = { key: 'observer.select-history', version: 2, input: selectionInputCodec, output: selectionCodec, points: Object.values(this.points) };
  }

  private async execute(work: GroupWork<SelectionInput, Selection, ConversationResources>): Promise<Selection> {
    const request = work.children.create(this.prepareRequest, work.input, { key: 'request' });
    const range = work.resources.history;
    const basis = { start: range.start, end: range.end - 1 };
    work.checkpoint?.({ point: this.points.requestWaiting, state: basis, refs: { child: request.ref } });
    return this.receiveRequest(work, request, basis);
  }
  private async receiveRequest(work: GroupWork<SelectionInput, Selection, object>, request: ChildCall<PrepareModelRequest<SelectionInput, ModelRequestResources & HistoryResources>>, basis: SelectionBasis): Promise<Selection> {
    const prepared = await request.invoke();
    const model = work.children.create(this.requestModel, prepared, { key: 'model' });
    work.checkpoint?.({ point: this.points.modelWaiting, state: basis, refs: { child: model.ref } });
    return this.receiveModel(work, model, basis);
  }
  private async receiveModel(work: GroupWork<SelectionInput, Selection, object>, model: ChildCall<RequestModel>, basis: SelectionBasis): Promise<Selection> {
    const output = await model.invoke();
    const acceptance = work.children.create(this.acceptOutput, { output, basis }, { key: 'acceptance' });
    work.checkpoint?.({ point: this.points.acceptanceWaiting, state: null, refs: { child: acceptance.ref } });
    return this.receiveAcceptance(work, acceptance);
  }
  private async receiveAcceptance(work: GroupWork<SelectionInput, Selection, object>, acceptance: ChildCall<AcceptModelOutput<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>>): Promise<Selection> {
    const result = await acceptance.invoke();
    work.checkpoint?.({ point: this.points.result, state: result, refs: {} });
    return result;
  }
}

/** Capacity preparation shares the request definition without initializing a selection behavior. */
export function selectionCapacity(input: SelectionInput, range: TranscriptRangeReader, settings: ModelSettings) {
  return estimateCapacity(loadRequest(selectionPayload(input, range.entries().slice(0, -1)), selectionTask, selectionOutputContract.schema, settings), settings);
}

function selectionPayload(input: SelectionInput, history: ReturnType<typeof historyMessages>) {
  return { message: input.message, memories: input.memories, history: history.map(({ index, message }) => ({ index, role: message.role, content: message.content })) };
}
