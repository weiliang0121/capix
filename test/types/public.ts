import { Resources } from '@weiliang0121/capix-runtime';
import type { BuiltCallable, CallableInput, Group, GroupWork } from '@weiliang0121/capix-runtime';
import { CallableBuilder, BoundChildren, ChildBindingsBuilder, type Invocation, type CallableContext, type InvocationContext, type InvocationWorkBinding, type InvocationOptions, type CallableSourceBinding, createRootInvocation } from '@weiliang0121/capix-runtime/construction';
import { Transcript } from '@weiliang0121/capix-transcript';
import { RecordResource, type ResourceRecord as ResourceRecordEntity } from '@weiliang0121/capix-records';
import type { ResourceRecord, ExecutionRecordSnapshot } from '@weiliang0121/capix-protocol/recording';
import type { ConversationRequest } from '@weiliang0121/capix-protocol/conversation';
import type { InvocationOrigin } from '@weiliang0121/capix-protocol/invocation';
import type { TranscriptSnapshot } from '@weiliang0121/capix-protocol/content';
import type { ObserverChange } from '@weiliang0121/capix-protocol/observer';
import type { MemoryInput } from '@capix/observer-service/conversation';
import { defineGroup, defineNode, defineScene } from '@weiliang0121/capix-runtime';
import { ActiveViewResource } from '@capix/observer-content';
import { MaintainConversationContent, PrepareConversationContext, type ContextMaintenanceInput, type ContextMaintenanceDecision, type ContextMaintenancePolicy } from '@capix/observer-service/conversation';

const recordReader = defineNode<string, unknown>()({
  deps: { records: RecordResource.read.request() },
  run(work) {
    const entry = work.resources.records.get(work.input);
    const value: unknown = entry?.data.value;
    // @ts-expect-error A read endpoint cannot create content.
    work.resources.records.create('content');
    // @ts-expect-error Record snapshots do not expose live entity methods.
    entry?.toJSON();
    return value;
  },
});
const recordCreator = defineNode<string, string>()({
  deps: { records: RecordResource.write.request() },
  run(work) {
    const entry = work.resources.records.create({ text: work.input });
    // @ts-expect-error Ordinary content writers cannot mutate invocation records.
    work.resources.records.update(entry, () => undefined);
    // @ts-expect-error Writing content does not implicitly grant collection reads.
    work.resources.records.snapshot();
    return entry.data.id;
  },
});
void [recordReader, recordCreator];

const maintenancePolicy = defineGroup<ContextMaintenanceInput, ContextMaintenanceDecision>()({
  name: 'explicit-policy',
  label: 'Explicit policy',
  source: 'test',
  members: [],
  deps: { active: ActiveViewResource.read.request() },
  run(work) {
    const current = work.resources.active.capture();
    const phase: 'before-request' | 'after-content' = work.input.phase;
    // @ts-expect-error A read offer does not grant index installation.
    work.resources.active.apply({});
    // @ts-expect-error An undeclared model port is not inferred from surrounding supplies.
    work.resources.model.invoke();
    void phase;
    return { basis: current.basis, messageIndexes: current.messages.map((item) => item.index), memoryIds: current.memories.map((item) => item.id) };
  },
});
const maintenance = new MaintainConversationContent(maintenancePolicy);
const preparation = new PrepareConversationContext(maintenance);
const functionalPolicy: ContextMaintenancePolicy = ({ material }) => ({ basis: material.basis, messageIndexes: [], memoryIds: [] });
// @ts-expect-error Maintenance decisions must carry a fixed source basis.
const ungroundedPolicy: ContextMaintenancePolicy = () => ({ messageIndexes: [], memoryIds: [] });
// @ts-expect-error Preparation consumes an ordinary accepted input, including its formal message index.
const missingPosition: CallableInput<typeof preparation> = { message: { role: 'user', content: 'input' } };
void [functionalPolicy, ungroundedPolicy, missingPosition];

const sourceScene = defineScene<string, string>()({ run: (work) => work.input });
const bound = new CallableBuilder().build(sourceScene, new Resources());
const originalScene: typeof sourceScene = bound;
type CallableWork = InvocationWorkBinding<string, string, CallableContext<string, string>, object, 'scene'>;
// @ts-expect-error Author Work needs callable resources and signal, not a bare invocation context.
type MissingWorkResources = InvocationWorkBinding<string, string, InvocationContext<string, string>, object, 'scene'>;
const configured = new CallableBuilder().build(defineScene<string, number>()({ run: (work) => work.input.length }), new Resources<{ tag: string }>());
const configuredCall = createRootInvocation(configured, 'input', { tag: 'fixed' });
const configuredOutput: Promise<number> = configuredCall.run();
// @ts-expect-error The built structure retains its host options contract.
createRootInvocation(configured, 'input', {});
// @ts-expect-error Installing resources does not widen the structure input.
createRootInvocation(configured, 42, { tag: 'fixed' });
void configuredOutput;
// @ts-expect-error R is the bound structure, not the owner of its assembly environment.
bound.environment;
// @ts-expect-error child call construction is supplied to binders, not exposed by R.
bound.executionInvocationBuilder;
const transcript = new Transcript();
const request: ConversationRequest = { messages: [{ role: 'user', content: 'input' }] };
declare const author: GroupWork<string, number, { value: string }>;
const value: string = author.resources.value;
// @ts-expect-error A declaration cannot mutate the internal invocation lifecycle.
author.complete(1);
// @ts-expect-error A declaration cannot traverse a parent context to fetch resources.
author.parent;
// @ts-expect-error Work does not expose or execute the underlying Invocation.
author.invocation.run();
declare const record: ResourceRecordEntity;
const data: ResourceRecord = record.toJSON();
declare const detail: ExecutionRecordSnapshot;
declare const origin: InvocationOrigin;
declare const snapshot: TranscriptSnapshot;
declare const change: ObserverChange;
declare const input: MemoryInput;
void [bound, originalScene, transcript, request, value, data, detail, origin, snapshot, change, input];

declare const childStructures: BoundChildren;
declare const parentCall: Invocation;
const childBuilder = new ChildBindingsBuilder(childStructures);
const childBindings = childBuilder.build(parentCall, { validate: () => parentCall.requireActive(), references: childBuilder.references(parentCall) });
// @ts-expect-error reusable structures no longer construct call-scoped access themselves
childStructures.forInvocation(parentCall);
// @ts-expect-error bindings do not expose the internal invocation or shared registry
childBindings.parent;
// @ts-expect-error the caller must provide the registry shared by this invocation's phases
childBuilder.build(parentCall, { validate: () => parentCall.requireActive() });

// Different input, output and resource shapes verify the shared parameter order.
type ExecutionResources = { label: string };
type CallContext = CallableContext<string, number, ExecutionResources>;
const work: InvocationOptions<string, number, CallContext>['work'] = {
  execute(context, invocation) {
    const label: string = context.resources.values.label;
    const input: string = invocation.context.currentInput;
    return label.length + input.length;
  },
};
declare const reusable: BuiltCallable<Group<string, number>, {}>;
// @ts-expect-error A reusable E structure is not the state of one E invocation.
const callContext: CallContext = reusable;
declare const node: import('@weiliang0121/capix-runtime').Node<string, number>;
declare const invocationBindings: CallableSourceBinding<{}, { label: string }, typeof node>;
// @ts-expect-error a source binding does not contain a separate entry resource scope.
invocationBindings.entry({ text: 'input' });
const captured = invocationBindings.capture?.('accepted input', {});
// @ts-expect-error capture receives the selected definition's real input contract.
invocationBindings.capture?.(42, {});
void [work, callContext, captured];
