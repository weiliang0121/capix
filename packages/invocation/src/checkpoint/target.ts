import { stableValue, type Stable, type RuntimeErrorValue } from '@weiliang0121/capix-contracts';
import { decodeCheckpointData } from './data.js';
import { decodeCheckpointDiagnostic } from './facts.js';
import { InvocationContext } from '../context/context.js';
import { invocationContextView } from '../context/view.js';
import type { InvocationTarget } from '../invocation/relation.js';
import type { CheckpointChild } from '@weiliang0121/capix-checkpoint';
import type { CheckpointBinding } from './work.js';

/** Saved direct delivery, with no runnable work, resource access or lifecycle setters in its view. */
export function checkpointTarget(child: CheckpointChild, binding?: CheckpointBinding, signal: AbortSignal = new AbortController().signal): InvocationTarget {
  const input = binding ? stableValue(binding.input.decode(child.input)) : decodeCheckpointData(child.input);
  const context = new InvocationContext<unknown, unknown>(input);
  const output = child.state.kind === 'returned' ? (binding ? stableValue(binding.output.decode(child.state.output)) : decodeCheckpointData(child.state.output)) : undefined;
  const failure = child.state.kind === 'failed' ? Object.freeze({ ...child.state.failure, error: child.state.error }) : undefined;
  if (child.state.kind === 'returned') {
    const progress = child.state.progress;
    context.installDelivery({ id: child.identity.contextId, round: progress.round, currentInput: binding ? stableValue(binding.input.decode(progress.currentInput)) : decodeCheckpointData(progress.currentInput), phase: progress.phase }, output);
  } else if (child.state.kind === 'failed') {
    const progress = child.state.progress;
    const diagnostic: Stable<RuntimeErrorValue> = decodeCheckpointDiagnostic(child.state.error);
    context.installFailure({ id: child.identity.contextId, round: progress.round, currentInput: binding ? stableValue(binding.input.decode(progress.currentInput)) : decodeCheckpointData(progress.currentInput), phase: progress.phase }, failure!, diagnostic);
  } else context.installIdentity(child.identity.contextId);
  const run = async () => {
    if (child.state.kind === 'failed') throw new Error('Historical failed child cannot execute or deliver again');
    if (child.state.kind !== 'returned') throw new Error('Saved child has no final delivery; explicitly resume its declared checkpoint');
    if (child.state.reception.kind === 'failed') throw new Error('Historical failed reception cannot execute or deliver again');
    return output;
  };
  const view = Object.freeze({
    context: Object.freeze({ ...invocationContextView(context), kind: child.identity.kind, signal }),
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
