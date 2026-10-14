import { z } from 'zod';
import { isEqual } from 'es-toolkit/predicate';
import { checkpointCodec } from '../../checkpoint.js';
import { selectionInputCodec, selectionCodec, childWaitingCodec, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { invocationRecording } from '@capix/server-runtime/recording';
import type { ChildBindings } from '@capix/server-runtime';
import { TranscriptResource } from '@capix/server-runtime/content';
import { ModelSettingsResource, ModelResource } from '../../model/resources.js';
import { type ConversationResources, type ModelRequestResources, type HistoryResources } from '../../resources.js';
import type { InvocationWorkView, InvocationCheckpointDefinition, InvocationCheckpointFrame, ChildInvocationView } from '@capix/server-runtime';
import type { ModelSettings } from '@capix/protocol';
import type { Selection, ModelRequest, ModelOutput } from '../../model/types.js';
import { OperationDefinition, type OperationContextView } from '@capix/server-runtime';
import { type TranscriptRangeReader } from '@capix/server-runtime/content';
import { historyMessages, type SelectionInput } from './input.js';
import { selectionOutputContract, type SelectionBasis } from './output.js';

import { PrepareModelRequestDefinition } from '../../attempt/model/prepare.js';
import { RequestModelDefinition } from '../model/request.js';
import { AcceptModelOutputDefinition, type ModelAcceptanceInput } from '../../attempt/model/accept.js';

import { loadRequest } from '../../model/request.js';
import { estimateCapacity } from '../../model/capacity.js';

const selectionTask = `结合 memories 中的已有理解和 history 中的可见原文，为回答当前 message 选择充分且相关的历史依据。关注指代、仍有效的条件，以及能补充或修正已有理解的信息；由你判断需要哪些原文，不只按关键词匹配。
history 仅覆盖当前消息段，memories 可能保留旧段理解，但不保证正确，也不代表其来源原文可见。sourceResults 中的 file-created 是系统接纳的历史创建凭据，不保证文件当前仍存在或正文未变。historyIndexes 只能选自 history，按相关性与必要性从高到低排列，不重复；无需原文时返回空数组。不生成回答。`;

const selectionRequestResources = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request() });

export class SelectHistoryDefinition extends OperationDefinition<SelectionInput, Selection, ConversationResources> {
  readonly observation = [invocationRecording()];
  readonly name = 'selection';
  readonly label = '选择历史';
  readonly source = 'services/observer/src/conversation/operations/history/select.ts · SelectHistoryDefinition';
  protected readonly purpose = 'selection';
  protected readonly outputContract = selectionOutputContract;

  static readonly requires = Object.freeze({ settings: ModelSettingsResource.snapshot.request(), history: TranscriptResource.fixedRange.request(), timeoutMs: ModelSettingsResource.timeout.request(), modelCreator: ModelResource.create.request(), modelReader: ModelResource.read.request() } as const);
  readonly run;
  readonly children;
  readonly checkpoint: InvocationCheckpointDefinition<SelectionInput, Selection, OperationContextView<SelectionInput, Selection, ConversationResources>>;

  readonly prepareRequestDefinition: PrepareModelRequestDefinition<SelectionInput, ModelRequestResources & HistoryResources>;
  readonly requestModelDefinition: RequestModelDefinition;
  readonly acceptOutputDefinition: AcceptModelOutputDefinition<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>;

  constructor() {
    super();
    this.prepareRequestDefinition = new PrepareModelRequestDefinition<SelectionInput, ModelRequestResources & HistoryResources>((input, resources) => loadRequest(selectionPayload(input, historyMessages(resources.history, input.message)), selectionTask, this.outputContract.schema, resources.settings), selectionRequestResources);
    this.requestModelDefinition = new RequestModelDefinition(this.purpose);
    this.acceptOutputDefinition = new AcceptModelOutputDefinition({ schema: this.outputContract.schema, accept: (value, input: ModelAcceptanceInput & { basis: SelectionBasis }) => this.outputContract.accept(value, input.basis) });
    this.children = Object.freeze([this.prepareRequestDefinition, this.requestModelDefinition, this.acceptOutputDefinition]);
    this.checkpoint = {
      key: 'observer.select-history',
      version: 1,
      input: selectionInputCodec,
      output: selectionCodec,
      points: {
        requestWaiting: {
          state: checkpointCodec(z.strictObject({ childId: z.string().min(1), basis: z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() }) })),
          check: (frame, state) => {
            originalCheckpoint(frame);
            const child = waitingChild(frame, state, 'request', this.prepareRequestDefinition.checkpoint);
            if (frame.children.length !== 1 || !isEqual(child.input, frame.currentInput) || state.basis.end < state.basis.start) throw new Error('Selection preparation checkpoint changed input');
          },
          resume: { requires: {}, uses: this.children, execute: (_context, invocation, children, state: { childId: string; basis: SelectionBasis }) => this.receiveRequest(invocation, children, children.get(this.prepareRequestDefinition).resume(invocation, state.childId), state.basis) },
        },
        acceptanceWaiting: {
          state: childWaitingCodec,
          check: (frame, state) => {
            originalCheckpoint(frame);
            const child = waitingChild(frame, state, 'acceptance', this.acceptOutputDefinition.checkpoint);
            const model = acceptedChild(frame.children[1]);
            if (frame.children.length !== 3 || model.key !== 'model' || !isEqual((child.input as { output: unknown }).output, model.state.reception.output)) throw new Error('Selection acceptance checkpoint changed feedback');
          },
          resume: { requires: {}, uses: [this.acceptOutputDefinition], execute: (_context, invocation, children, state: { childId: string }) => this.receiveAcceptance(invocation, children, children.get(this.acceptOutputDefinition).resume(invocation, state.childId)) },
        },
        modelWaiting: { state: checkpointCodec(z.strictObject({ childId: z.string().min(1), basis: z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() }) })), check: (frame, state) => this.checkWaiting(frame, state), resume: { requires: {}, uses: [this.requestModelDefinition, this.acceptOutputDefinition], execute: (_context, invocation, children, state: { childId: string; basis: SelectionBasis }) => this.receiveModel(invocation, children, children.get(this.requestModelDefinition).resume(invocation, state.childId), state.basis) } },
        result: {
          state: selectionCodec,
          check: (frame, output) => {
            originalCheckpoint(frame);
            const accepted = acceptedChild(frame.children.at(-1));
            if (accepted.key !== 'acceptance' || !isEqual(accepted.state.reception.output, output)) throw new Error('Selection checkpoint differs from accepted result');
          },
          resume: { requires: {}, uses: [], execute: (_context, _invocation, _children, output: Selection) => output },
        },
      },
    };
    this.run = { requires: SelectHistoryDefinition.requires, uses: this.children, execute: this.execute.bind(this) };
  }

  private async execute(context: OperationContextView<SelectionInput, Selection, ConversationResources>, invocation: InvocationWorkView<SelectionInput, Selection, OperationContextView<SelectionInput, Selection, ConversationResources>>, children: ChildBindings): Promise<Selection> {
    const request = children.get(this.prepareRequestDefinition).create(invocation, context.currentInput, { key: 'request' });
    const range = context.resources.values.history;
    const basis = { start: range.start, end: range.end - 1 };
    invocation.checkpoint?.save('requestWaiting', { childId: request.context.id, basis });
    return this.receiveRequest(invocation, children, request, basis);
  }
  private async receiveRequest(invocation: InvocationWorkView<SelectionInput, Selection, OperationContextView<SelectionInput, Selection, any>>, children: ChildBindings, request: ChildInvocationView<SelectionInput, ModelRequest>, basis: SelectionBasis): Promise<Selection> {
    await request.run();
    const prepared = await children.accept(request, (value) => value);
    const model = children.get(this.requestModelDefinition).create(invocation, prepared, { key: 'model' });
    invocation.checkpoint?.save('modelWaiting', { childId: model.context.id, basis });
    return this.receiveModel(invocation, children, model, basis);
  }
  private async receiveModel(invocation: InvocationWorkView<SelectionInput, Selection, OperationContextView<SelectionInput, Selection, any>>, children: ChildBindings, model: ChildInvocationView<ModelRequest, ModelOutput>, basis: SelectionBasis): Promise<Selection> {
    await model.run();
    const output = await children.accept(model, (value) => value);
    const acceptance = children.get(this.acceptOutputDefinition).create(invocation, { output, basis } as ModelAcceptanceInput & { basis: SelectionBasis }, { key: 'acceptance' });
    invocation.checkpoint?.save('acceptanceWaiting', { childId: acceptance.context.id });
    return this.receiveAcceptance(invocation, children, acceptance);
  }
  private async receiveAcceptance(invocation: InvocationWorkView<SelectionInput, Selection, OperationContextView<SelectionInput, Selection, any>>, children: ChildBindings, acceptance: ChildInvocationView<ModelAcceptanceInput & { basis: SelectionBasis }, Selection>): Promise<Selection> {
    await acceptance.run();
    const result = await children.accept(acceptance, (value) => value);
    invocation.checkpoint?.save('result', result);
    return result;
  }
  private checkWaiting(frame: InvocationCheckpointFrame, state: { childId: string; basis: SelectionBasis }): void {
    originalCheckpoint(frame);
    const model = waitingChild(frame, state, 'model', this.requestModelDefinition.checkpoint);
    const request = acceptedChild(frame.children[0]);
    if (frame.children.length !== 2 || request.key !== 'request' || !isEqual(request.input, frame.currentInput) || !isEqual(model.input, request.state.reception.output) || state.basis.end < state.basis.start) throw new Error('Selection checkpoint differs from prepared model request');
  }
}

/** Capacity preparation shares the request definition without initializing a selection behavior. */
export function selectionCapacity(input: SelectionInput, range: TranscriptRangeReader, settings: ModelSettings) {
  return estimateCapacity(loadRequest(selectionPayload(input, range.entries().slice(0, -1)), selectionTask, selectionOutputContract.schema, settings), settings);
}

function selectionPayload(input: SelectionInput, history: ReturnType<typeof historyMessages>) {
  return { message: input.message, memories: input.memories, history: history.map(({ index, message }) => ({ index, role: message.role, content: message.content })) };
}
