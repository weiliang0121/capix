import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext } from '../../context/execution.js';
import { OperationContext } from '../../context/operation.js';
import type { OperationContextBuilder } from '../../context/operation/builder.js';
import { OperationRecordHelper, type OperationDescription } from '../../records/operation/helper.js';

export interface OperationInvocationRequest<I, O> {
  input: I;
  key?: string;
  description: OperationDescription;
  work: InvocationWork<OperationContext<I, O>, I, O>;
}

export class OperationInvocationBuilder {
  constructor(
    private readonly contexts: OperationContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<I, O>(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, request: OperationInvocationRequest<I, O>): Invocation<I, O, OperationContext<I, O>> {
    const owner = parent.context;
    const parentContext = owner instanceof OperationContext ? owner : undefined;
    const execution = owner instanceof OperationContext ? owner.executionContext : owner;
    const context = this.contexts.create<I, O>(execution, request.input, parentContext);
    const recording = this.capabilities.recording ? OperationRecordHelper.recording<I, O>(this.capabilities.recording, request.description, parent) : undefined;
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'operation', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    return new Invocation({ parent: { invocation: parent, key: request.key }, context, work: request.work, signal: context.signal, recording, changes, validate: () => this.contexts.check(execution, parentContext) });
  }
}
