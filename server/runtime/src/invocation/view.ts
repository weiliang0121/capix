import type { InvocationFailure } from './failure.js';
import type { InvocationScope } from '../context/scope.js';
import type { InvocationResult } from './result.js';
import type { InvocationRelationReception } from './relation.js';

export interface InvocationRelationView {
  readonly invocation: InvocationView;
  readonly round: number;
  readonly key?: string;
  readonly returned: InvocationResult<unknown> | undefined;
  readonly reception: InvocationRelationReception;
}

export interface InvocationView<I = unknown, O = unknown, C extends InvocationScope<I, O> = InvocationScope<I, O>> {
  readonly context: C;
  readonly origin: Readonly<{ contextId: string }>;
  readonly sequence: number;
  readonly failure?: InvocationFailure;
  readonly children: {
    get(invocation: InvocationView): InvocationRelationView;
    values(): readonly InvocationRelationView[];
  };
}

export interface ChildCall<I = unknown, O = unknown, C extends InvocationScope<I, O> = InvocationScope<I, O>> extends InvocationView<I, O, C> {
  run(): Promise<O>;
}
