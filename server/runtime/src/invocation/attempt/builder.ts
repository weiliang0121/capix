import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { AttemptContext } from '../../context/attempt.js';
import type { OperationContext } from '../../context/operation.js';
import type { AttemptContextBuilder } from '../../context/attempt/builder.js';
import { AttemptRecordHelper, type AttemptDescription } from '../../records/attempt/helper.js';
import type { InvocationRecordHelper } from '../../records/invocation/helper.js';

export class AttemptInvocationBuilder {
  constructor(
    private readonly contexts: AttemptContextBuilder,
    private readonly recording?: InvocationRecordHelper,
  ) {}

  create<I, O>(parent: Invocation<unknown, unknown, OperationContext>, input: I, description: AttemptDescription, work: InvocationWork<AttemptContext<I, O>, I, O>): Invocation<I, O, AttemptContext<I, O>> {
    const context = this.contexts.create<I, O>(parent.context, input);
    const recording = this.recording ? AttemptRecordHelper.recording<I, O>(this.recording, description, parent) : undefined;
    return new Invocation({ context, work, signal: context.signal, recording, validate: () => this.contexts.check(parent.context) });
  }
}
