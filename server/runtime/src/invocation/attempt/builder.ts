import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { AttemptContext } from '../../context/attempt.js';
import type { OperationContext } from '../../context/operation.js';
import type { AttemptContextBuilder } from '../../context/attempt/builder.js';
import { AttemptRecordHelper, type AttemptDescription } from '../../records/attempt/helper.js';

export interface AttemptInvocationRequest<I, O> {
  input: I;
  description: AttemptDescription;
  work: InvocationWork<AttemptContext<I, O>, I, O>;
}

export class AttemptInvocationBuilder {
  constructor(
    private readonly contexts: AttemptContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<I, O>(parent: Invocation<unknown, unknown, OperationContext>, request: AttemptInvocationRequest<I, O>): Invocation<I, O, AttemptContext<I, O>> {
    const context = this.contexts.create<I, O>(parent.context, request.input);
    const recording = this.capabilities.recording ? AttemptRecordHelper.recording<I, O>(this.capabilities.recording, request.description, parent) : undefined;
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'attempt', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    return new Invocation({ context, work: request.work, signal: context.signal, recording, changes, validate: () => this.contexts.check(parent.context) });
  }
}
