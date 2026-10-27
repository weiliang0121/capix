import { InvocationObservation, ObserverSession } from '@capix/invocation';

/** Focused call-mechanism tests observe real facts without installing the record preset. */
export function observeCall(observe, failure = 'propagate') {
  return new InvocationObservation([new ObserverSession({ observe }, failure)], new Map());
}
