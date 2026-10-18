import type { OperationWork } from '@capix/server-runtime';
import { createBoundRuntime, BoundRuntime, BoundChildren, ChildBindingsBuilder, type Invocation, type BoundExecution, type ExecutionContext, type InvocationOptions, type ExecutionInvocationBindings } from '@capix/server-runtime/construction';
import { Transcript } from '@capix/server-runtime/content';
import type { ResourceRecord as ResourceRecordEntity } from '@capix/server-runtime/recording';
import type { ResourceRecord, ExecutionRecordSnapshot } from '@capix/protocol/recording';
import type { ConversationRequest } from '@capix/protocol/conversation';
import type { InvocationOrigin } from '@capix/protocol/invocation';
import type { TranscriptSnapshot } from '@capix/protocol/content';
import type { ObserverChange } from '@capix/protocol/observer';
import type { MemoryInput } from '@capix/observer-service/conversation';
import { defineOperation } from '@capix/server-runtime';
import { ActiveContentResource, MaintainConversationContentDefinition, PrepareConversationContextDefinition, type ContextMaintenanceInput, type ContextMaintenanceDecision, type ContextMaintenancePolicy } from '@capix/observer-service/conversation';

const maintenancePolicy = defineOperation<ContextMaintenanceInput, ContextMaintenanceDecision>()({
  name: 'explicit-policy',
  label: 'Explicit policy',
  source: 'test',
  children: [],
  run: {
    requires: { active: ActiveContentResource.read.request() },
    execute(work) {
      const current = work.resources.active.capture();
      const phase: 'before-request' | 'after-content' = work.input.phase;
      // @ts-expect-error A read offer does not grant index installation.
      work.resources.active.apply({});
      // @ts-expect-error An undeclared model port is not inferred from surrounding supplies.
      work.resources.model.invoke();
      void phase;
      return { basis: current.basis, messageIndexes: current.messages.map((item) => item.index), memoryIds: current.memories.map((item) => item.id) };
    },
  },
});
const maintenance = new MaintainConversationContentDefinition(maintenancePolicy);
const preparation = new PrepareConversationContextDefinition(maintenance);
const functionalPolicy: ContextMaintenancePolicy = ({ material }) => ({ basis: material.basis, messageIndexes: [], memoryIds: [] });
// @ts-expect-error Maintenance decisions must carry a fixed source basis.
const ungroundedPolicy: ContextMaintenancePolicy = () => ({ messageIndexes: [], memoryIds: [] });
// @ts-expect-error Preparation consumes an ordinary accepted input, including its formal message index.
const missingPosition: Parameters<typeof preparation.run.execute>[0]['input'] = { message: { role: 'user', content: 'input' } };
void [functionalPolicy, ungroundedPolicy, missingPosition];

const bound: BoundRuntime = createBoundRuntime();
// @ts-expect-error R is the bound structure, not the owner of its assembly environment.
bound.environment;
// @ts-expect-error child call construction is supplied to binders, not exposed by R.
bound.executionInvocationBuilder;
const transcript = new Transcript();
const request: ConversationRequest = { messages: [{ role: 'user', content: 'input' }] };
declare const author: OperationWork<string, number, { value: string }>;
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
void [bound, transcript, request, value, data, detail, origin, snapshot, change, input];

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
type CallContext = ExecutionContext<string, number, ExecutionResources>;
const work: InvocationOptions<string, number, CallContext>['work'] = {
  maxRounds: 1,
  execute(context, invocation) {
    const label: string = context.resources.values.label;
    const input: string = invocation.context.currentInput;
    return label.length + input.length;
  },
};
declare const reusable: BoundExecution<string, number, ExecutionResources>;
// @ts-expect-error A reusable E structure is not the state of one E invocation.
const callContext: CallContext = reusable;
declare const invocationBindings: ExecutionInvocationBindings<string, number, ExecutionResources>;
// @ts-expect-error E bindings do not contain a separate entry resource scope.
invocationBindings.entry({ text: 'input' });
const captured = invocationBindings.capture('accepted input');
// @ts-expect-error Captured supply is not a local resource view; aliases are declared when selecting a call's resources.
captured.values.label;
declare const labelRequest: import('@capix/server-runtime').ResourceRequest<string>;
const label: string = captured.select({ label: labelRequest }).values.label;
void [work, callContext, label];
