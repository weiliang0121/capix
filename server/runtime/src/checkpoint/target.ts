import { InvocationContext } from '../context/context.js';
import { invocationContextView } from '../context/view.js';
import type { InvocationTarget } from '../invocation/relation.js';
import type { CheckpointChild } from './contract.js';
import type { CheckpointBinding } from './work.js';

/** Saved direct delivery, with no runnable work, resource access or lifecycle setters in its view. */
export function checkpointTarget(child: CheckpointChild, binding?: CheckpointBinding, signal: AbortSignal = new AbortController().signal): InvocationTarget {
  const input = binding ? binding.input.decode(child.input) : child.input;
  const context = new InvocationContext(input);
  const output = child.state.kind === 'returned' ? (binding ? binding.output.decode(child.state.output) : child.state.output) : undefined;
  const failure = child.state.kind === 'failed' ? Object.freeze({ ...child.state.failure, error: child.state.error }) : undefined;
  if (child.state.kind === 'returned') {
    const progress = child.state.progress;
    context.installDelivery({ id: child.identity.contextId, round: progress.round, currentInput: binding ? binding.input.decode(progress.currentInput) : progress.currentInput, phase: progress.phase }, output);
  } else if (child.state.kind === 'failed') {
    const progress = child.state.progress;
    context.installFailure({ id: child.identity.contextId, round: progress.round, currentInput: binding ? binding.input.decode(progress.currentInput) : progress.currentInput, phase: progress.phase }, failure!);
  } else context.installIdentity(child.identity.contextId);
  const run = async () => {
    if (child.state.kind === 'failed') throw new Error('Historical failed child cannot execute or deliver again');
    if (child.state.kind !== 'returned') throw new Error('Saved child has no final delivery; explicitly resume its declared checkpoint');
    if (child.state.reception.kind === 'failed') throw new Error('Historical failed reception cannot execute or deliver again');
    return output;
  };
  const view = Object.freeze({
    context: Object.freeze({ ...invocationContextView(context), level: child.identity.level, signal }),
    origin: Object.freeze({ contextId: context.id }),
    sequence: 0,
    ...(failure ? { failure } : {}),
    children: Object.freeze({
      get: () => {
        throw new Error('Saved child descendants require their own checkpoint');
      },
      values: () => {
        throw new Error('Saved child descendants require their own checkpoint');
      },
    }),
  });
  return Object.freeze({ context, run, view, callView: Object.freeze({ ...view, run }), identity: child.identity, checkpointBinding: binding });
}
