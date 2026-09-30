import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext } from '../../context/execution.js';
import { OperationContext } from '../../context/operation.js';
import type { OperationContextBuilder } from '../../context/operation/builder.js';
import { OperationRecordHelper, type OperationDescription } from '../../records/operation/helper.js';
import type { InvocationRecordHelper } from '../../records/invocation/helper.js';

export class OperationInvocationBuilder {
  constructor(
    private readonly contexts: OperationContextBuilder,
    private readonly recording?: InvocationRecordHelper,
  ) {}

  create<I, O>(parent: Invocation<unknown, unknown, ExecutionContext> | Invocation<unknown, unknown, OperationContext>, input: I, description: OperationDescription, work: InvocationWork<OperationContext<I, O>, I, O>): Invocation<I, O, OperationContext<I, O>> {
    const owner = parent.context;
    const parentContext = owner instanceof OperationContext ? owner : undefined;
    const execution = owner instanceof OperationContext ? owner.executionContext : owner;
    const context = this.contexts.create<I, O>(execution, input, parentContext);
    const recording = this.recording ? OperationRecordHelper.recording<I, O>(this.recording, description, parent) : undefined;
    return new Invocation({ context, work, signal: context.signal, recording, validate: () => this.contexts.check(execution, parentContext) });
  }
}
