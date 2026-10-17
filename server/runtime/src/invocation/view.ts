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

/** Read-only call facts; constructing a view never requires the live Invocation. */
export type InvocationViewSource = Pick<InvocationView, 'origin' | 'sequence' | 'failure' | 'children'>;
type ContextOutput<Context extends InvocationContextView<any, any>> = Extract<Context['state'], { status: 'succeeded' }>['output'];

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

export function invocationView<Context extends InvocationContextView<any, any>>(source: InvocationViewSource, context: Context): InvocationView<Context['input'], ContextOutput<Context>, Context> {
  return Object.freeze(viewProperties(source, context));
}

export function childInvocationView<Context extends InvocationContextView<any, any>>(source: InvocationViewSource, context: Context, run: () => Promise<ContextOutput<Context>>): ChildInvocationView<Context['input'], ContextOutput<Context>, Context> {
  return Object.freeze(Object.assign(viewProperties(source, context), { run }));
}
