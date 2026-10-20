import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { checkpointCodec } from '../../checkpoint.js';
import { selectionInputCodec, selectionCodec, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import { TranscriptResource } from '@capix/server-runtime/content';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ConversationResources, type ModelRequestResources, type HistoryResources } from '../../resources.js';
import { checkpointPoint, childReference, type GroupWork, type ChildCall } from '@capix/server-runtime';
import type { ModelSettings } from '@capix/protocol';
import type { Selection } from '../../model/types.js';
import { GroupDefinition } from '@capix/server-runtime';
import { type TranscriptRangeReader } from '@capix/server-runtime/content';
import { historyMessages, type SelectionInput } from './input.js';
import { selectionOutputContract, type SelectionBasis } from './output.js';

import { PrepareModelRequestDefinition } from '../../node/model/prepare.js';
import { RequestModelDefinition } from '../model/request.js';
import { AcceptModelOutputDefinition, type ModelAcceptanceInput } from '../../node/model/accept.js';

import { loadRequest } from '../../model/request.js';
import { estimateCapacity } from '../../model/capacity.js';

const selectionTask = `结合 memories 中的已有理解和 history 中的可见原文，为回答当前 message 选择充分且相关的历史依据。关注指代、仍有效的条件，以及能补充或修正已有理解的信息；由你判断需要哪些原文，不只按关键词匹配。
history 仅覆盖当前消息段，memories 可能保留旧段理解，但不保证正确，也不代表其来源原文可见。sourceResults 中的 file-created 是系统接纳的历史创建凭据，不保证文件当前仍存在或正文未变。historyIndexes 只能选自 history，按相关性与必要性从高到低排列，不重复；无需原文时返回空数组。不生成回答。`;

const selectionRequestResources = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request() });

export class SelectHistoryDefinition extends GroupDefinition<SelectionInput, Selection, ConversationResources> {
  readonly observation = [invocationRecording()];
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'services/observer/src/conversation/group/history/select.ts · SelectHistoryDefinition';
  protected readonly purpose = 'selection';
  protected readonly outputContract = selectionOutputContract;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), timeoutMs: ModelSettingsResource.timeout.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() } as const);
  readonly run;
  readonly members;
  readonly checkpoint;
  readonly points;

  readonly prepareRequestDefinition: PrepareModelRequestDefinition<SelectionInput, ModelRequestResources & HistoryResources>;
  readonly requestModelDefinition: RequestModelDefinition;
  readonly acceptOutputDefinition: AcceptModelOutputDefinition<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>;

  constructor() {
    super();
    this.prepareRequestDefinition = new PrepareModelRequestDefinition<SelectionInput, ModelRequestResources & HistoryResources>((input, resources) => loadRequest(selectionPayload(input, historyMessages(resources.history, input.message)), selectionTask, this.outputContract.schema, resources.settings), selectionRequestResources);
    this.requestModelDefinition = new RequestModelDefinition(this.purpose);
    this.acceptOutputDefinition = new AcceptModelOutputDefinition({ schema: this.outputContract.schema, accept: (value, input: ModelAcceptanceInput & { basis: SelectionBasis }) => this.outputContract.accept(value, input.basis) });
    this.members = Object.freeze([this.prepareRequestDefinition, this.requestModelDefinition, this.acceptOutputDefinition]);
    const point = checkpointPoint<'group', SelectionInput, Selection>();
    const basisCodec = checkpointCodec(z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() }));
    this.points = {
      requestWaiting: point({
        name: 'requestWaiting',
        state: basisCodec,
        references: { child: childReference(this.prepareRequestDefinition) },
        check: (basis, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'request');
          if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input) || basis.end < basis.start) throw new Error('Selection preparation checkpoint changed input');
        },
        resume: { uses: this.members, execute: (work, basis, saved) => this.receiveRequest(work, work.children.resume(saved.child), basis) },
      }),
      acceptanceWaiting: point({
        name: 'acceptanceWaiting',
        state: emptyCheckpointState,
        references: { child: childReference(this.acceptOutputDefinition) },
        check: (_state, facts) => {
          originalCheckpoint(facts);
          const child = waitingChild(facts, facts.references.child, 'acceptance');
          const model = acceptedChild(facts.children.requireUnique(this.requestModelDefinition, { parentRound: 1 }));
          if (facts.children.values().length !== 3 || model.key !== 'model' || !isEqual(child.input.output, model.reception.value)) throw new Error('Selection acceptance checkpoint changed feedback');
        },
        resume: { uses: [this.acceptOutputDefinition], execute: (work, _state, saved) => this.receiveAcceptance(work, work.children.resume(saved.child)) },
      }),
      modelWaiting: point({
        name: 'modelWaiting',
        state: basisCodec,
        references: { child: childReference(this.requestModelDefinition) },
        check: (basis, facts) => {
          originalCheckpoint(facts);
          const model = waitingChild(facts, facts.references.child, 'model');
          const request = acceptedChild(facts.children.requireUnique(this.prepareRequestDefinition, { parentRound: 1 }));
          if (facts.children.values().length !== 2 || request.key !== 'request' || !isEqual(request.input, facts.input) || !isEqual(model.input, request.reception.value) || basis.end < basis.start) throw new Error('Selection checkpoint differs from prepared model request');
        },
        resume: { uses: [this.requestModelDefinition, this.acceptOutputDefinition], execute: (work, basis, saved) => this.receiveModel(work, work.children.resume(saved.child), basis) },
      }),
      result: point({
        name: 'result',
        state: selectionCodec,
        references: {},
        check: (output, facts) => {
          originalCheckpoint(facts);
          const accepted = acceptedChild(facts.children.requireUnique(this.acceptOutputDefinition, { parentRound: 1 }));
          if (accepted.key !== 'acceptance' || !isEqual(accepted.reception.value, output)) throw new Error('Selection checkpoint differs from accepted result');
        },
        resume: { execute: (_work, output) => output },
      }),
    };
    this.checkpoint = { key: 'observer.select-history', version: 2, input: selectionInputCodec, output: selectionCodec, points: Object.values(this.points) };
    this.run = { requires: SelectHistoryDefinition.requires, uses: this.members, execute: this.execute.bind(this) };
  }

  private async execute(work: GroupWork<SelectionInput, Selection, ConversationResources>): Promise<Selection> {
    const request = work.children.create(this.prepareRequestDefinition, work.input, { key: 'request' });
    const range = work.resources.history;
    const basis = { start: range.start, end: range.end - 1 };
    work.checkpoint?.save(this.points.requestWaiting, basis, { child: request.ref });
    return this.receiveRequest(work, request, basis);
  }
  private async receiveRequest(work: GroupWork<SelectionInput, Selection, object>, request: ChildCall<PrepareModelRequestDefinition<SelectionInput, ModelRequestResources & HistoryResources>>, basis: SelectionBasis): Promise<Selection> {
    await request.run();
    const prepared = await request.accept();
    const model = work.children.create(this.requestModelDefinition, prepared, { key: 'model' });
    work.checkpoint?.save(this.points.modelWaiting, basis, { child: model.ref });
    return this.receiveModel(work, model, basis);
  }
  private async receiveModel(work: GroupWork<SelectionInput, Selection, object>, model: ChildCall<RequestModelDefinition>, basis: SelectionBasis): Promise<Selection> {
    await model.run();
    const output = await model.accept();
    const acceptance = work.children.create(this.acceptOutputDefinition, { output, basis }, { key: 'acceptance' });
    work.checkpoint?.save(this.points.acceptanceWaiting, null, { child: acceptance.ref });
    return this.receiveAcceptance(work, acceptance);
  }
  private async receiveAcceptance(work: GroupWork<SelectionInput, Selection, object>, acceptance: ChildCall<AcceptModelOutputDefinition<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>>): Promise<Selection> {
    await acceptance.run();
    const result = await acceptance.accept();
    work.checkpoint?.save(this.points.result, result, {});
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
