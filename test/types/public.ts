import type { OperationContextView, InvocationView } from '@capix/server-runtime';
import { createBoundRuntime, BoundRuntime, type BoundExecution, type ExecutionContext, type InvocationOptions, type ExecutionInvocationBindings } from '@capix/server-runtime/construction';
import { Transcript } from '@capix/server-runtime/content';
import type { ResourceRecord as ResourceRecordEntity } from '@capix/server-runtime/recording';
import type { ResourceRecord, ExecutionRecordSnapshot } from '@capix/protocol/recording';
import type { ConversationRequest } from '@capix/protocol/conversation';
import type { InvocationOrigin } from '@capix/protocol/invocation';
import type { TranscriptSnapshot } from '@capix/protocol/content';
import type { ObserverChange } from '@capix/protocol/observer';
import type { MemoryInput } from '@capix/observer-service/conversation';

const bound: BoundRuntime = createBoundRuntime();
const transcript = new Transcript();
const request: ConversationRequest = { messages: [{ role: 'user', content: 'input' }] };
declare const context: OperationContextView<string, number, { value: string }>;
const value: string = context.resources.values.value;
// @ts-expect-error A declaration cannot mutate the internal invocation lifecycle.
context.complete(1);
// @ts-expect-error A declaration cannot traverse a parent context to fetch resources.
context.parent;
declare const invocation: InvocationView;
// @ts-expect-error Business views cannot execute an actual Invocation again.
invocation.run();
declare const record: ResourceRecordEntity;
const data: ResourceRecord = record.toJSON();
declare const detail: ExecutionRecordSnapshot;
declare const origin: InvocationOrigin;
declare const snapshot: TranscriptSnapshot;
declare const change: ObserverChange;
declare const input: MemoryInput;
void [bound, transcript, request, value, data, detail, origin, snapshot, change, input];

// Different input, output and resource shapes verify the shared parameter order.
type ExecutionResources = { label: string };
type EntryResources = { prefix: string };
type CallContext = ExecutionContext<string, number, ExecutionResources>;
const work: InvocationOptions<string, number, CallContext>['work'] = {
  maxRounds: 1,
  execute(context, invocation) {
    const label: string = context.resources.values.label;
    const input: string = invocation.context.currentInput;
    return label.length + input.length;
  },
};
declare const reusable: BoundExecution<string, number, ExecutionResources, { text: string }, EntryResources>;
// @ts-expect-error A reusable E structure is not the state of one E invocation.
const callContext: CallContext = reusable;
declare const invocationBindings: ExecutionInvocationBindings<string, number, ExecutionResources, { text: string }, EntryResources>;
const prefix: string = invocationBindings.entry({ text: 'input' }).values.prefix;
const label: string = invocationBindings.capture('accepted input').values.label;
void [work, callContext, prefix, label];
