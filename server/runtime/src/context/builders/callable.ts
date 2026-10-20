import type { CallableKind } from '@capix/protocol';
import { CallableContext } from '../callable.js';
import type { InvocationControls } from '../context.js';
import type { ResourceBindings } from '../../resource/bindings.js';

/** Shared construction ownership; callable kind is identity metadata, not a lifecycle choice. */
export class CallableContextBuilder {
  create<Input, Output, Resources extends object>(input: Input, kind: CallableKind, controls: InvocationControls, resources: ResourceBindings<Resources>, parent?: CallableContext): CallableContext<Input, Output, Resources> {
    if (parent) this.check(parent);
    return new CallableContext(input, kind, parent ? { signal: parent.signal } : controls, resources, this);
  }

  check(context: CallableContext): void {
    context.requireActive();
    if (!context.belongsTo(this)) throw new Error('Call belongs to another binding installation');
  }
}
