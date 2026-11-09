import type { Stable } from '@weiliang0121/capix-contracts';
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
  run(): Promise<Stable<Output>>;
}

/** Read-only call facts; constructing a view never requires the live Invocation. */
export type InvocationViewSource = Pick<InvocationView, 'origin' | 'sequence' | 'failure' | 'children'>;

function viewProperties<Context extends InvocationContextView<any, any>>(source: InvocationViewSource, context: Context) {
  return {
    context,
    origin: source.origin,
    get sequence() {
      return source.sequence;
    },
    get failure() {
      return source.failure;
    },
    children: source.children,
  };
}

export function invocationView<Input, Output, Context extends InvocationContextView<Input, Output>>(source: InvocationViewSource, context: Context): InvocationView<Input, Output, Context> {
  return Object.freeze(viewProperties(source, context));
}

export function childInvocationView<Input, Output, Context extends InvocationContextView<Input, Output>>(source: InvocationViewSource, context: Context, run: () => Promise<Stable<Output>>): ChildInvocationView<Input, Output, Context> {
  return Object.freeze(Object.assign(viewProperties(source, context), { run }));
}
