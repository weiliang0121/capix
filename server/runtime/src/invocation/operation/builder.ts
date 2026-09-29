import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { ExecutionContext } from '../../context/execution.js';
import type { OperationContext } from '../../context/operation.js';
import type { OperationContextBuilder } from '../../context/operation/builder.js';
import { OperationRecordHelper, type OperationDescription } from '../../records/operation/helper.js';
import type { InvocationRecordHelper } from '../../records/invocation/helper.js';

export class OperationInvocationBuilder {
  constructor(
    private readonly contexts: OperationContextBuilder,
    private readonly recording?: InvocationRecordHelper,
  ) {}

  create<I, O>(execution: ExecutionContext, input: I, description: OperationDescription, work: InvocationWork<OperationContext<I, O>, I, O>, parent?: OperationContext): Invocation<I, O, OperationContext<I, O>> {
    const context = this.contexts.create<I, O>(execution, input, parent);
    const recording = this.recording ? OperationRecordHelper.recording<I, O>(this.recording, description, parent) : undefined;
    return new Invocation({ context, work, signal: context.signal, recording, validate: () => this.contexts.check(execution, parent) });
  }
}
