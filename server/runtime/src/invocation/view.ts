import type { InvocationFailure } from './failure.js';
import type { InvocationContextView } from '../context/view.js';
import type { InvocationResult } from './result.js';
import type { InvocationRelationReception } from './relation.js';

export interface InvocationRelationView {
  readonly invocation: InvocationView;
  readonly round: number;
  readonly key?: string;
  readonly returned: InvocationResult<unknown> | undefined;
  readonly reception: InvocationRelationReception;
}

export interface InvocationView<Input = unknown, Output = unknown, ContextView extends InvocationContextView<Input, Output> = InvocationContextView<Input, Output>> {
  readonly context: ContextView;
  readonly origin: Readonly<{ contextId: string }>;
  readonly sequence: number;
  readonly failure?: InvocationFailure;
  readonly children: {
    get(invocation: InvocationView): InvocationRelationView;
    values(): readonly InvocationRelationView[];
  };
}

export interface ChildInvocationView<Input = unknown, Output = unknown, ContextView extends InvocationContextView<Input, Output> = InvocationContextView<Input, Output>> extends InvocationView<Input, Output, ContextView> {
  run(): Promise<Output>;
}
