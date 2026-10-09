import { attachInvocationResources } from '../resources.js';
import type { ResourceRequirements } from '../../resource/bindings.js';
import type { InvocationCapabilities } from '../capabilities.js';
import { InvocationChangeEmitter } from '../changes.js';
import { Invocation } from '../invocation.js';
import type { InvocationWork } from '../cycle.js';
import type { AttemptContext } from '../../context/attempt.js';
import type { OperationContext } from '../../context/operation.js';
import type { AttemptContextBuilder } from '../../context/attempt/builder.js';
import { AttemptRecordHelper, type AttemptDescription } from '../../records/attempt/helper.js';

export interface AttemptInvocationRequest<I, O, R extends object = object> {
  input: I;
  requires?: ResourceRequirements<R>;
  key?: string;
  description: AttemptDescription;
  work: InvocationWork<AttemptContext<I, O, R>, I, O>;
}

export class AttemptInvocationBuilder {
  constructor(
    private readonly contexts: AttemptContextBuilder,
    private readonly capabilities: InvocationCapabilities = {},
  ) {}

  create<I, O, R extends object = object>(parent: Invocation<unknown, unknown, OperationContext>, request: AttemptInvocationRequest<I, O, R>): Invocation<I, O, AttemptContext<I, O, R>> {
    this.contexts.check(parent.context);
    const context = this.contexts.create<I, O, R>(parent.context, request.input, parent.context.resources.select(request.requires ?? ({} as ResourceRequirements<R>)));
    const recording = this.capabilities.recording ? AttemptRecordHelper.recording<I, O>(this.capabilities.recording, request.description, parent) : undefined;
    const changes = this.capabilities.changes ? new InvocationChangeEmitter({ contextId: context.id, level: 'attempt', parentContextId: parent.context.id }, this.capabilities.changes) : undefined;
    const invocation = new Invocation<I, O, AttemptContext<I, O, R>>({ parent: { invocation: parent, key: request.key }, context, work: request.work, signal: context.signal, recording, changes, validate: () => this.contexts.check(parent.context) });
    attachInvocationResources(invocation, context.resources, this.capabilities.recording);
    return invocation;
  }
}
