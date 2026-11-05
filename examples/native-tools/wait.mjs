import { ModelReplyPending } from '@capix/conversation-service';
import { InvocationCancelled } from '@capix/invocation';

/**
 * One local wait. A timeout retains the existing interaction reference; it does
 * not retry, resend, or make the failed invocation's checkpoint resumable.
 */
export async function waitToolFeedback(channel, reference, operation, waitMs = 5_000) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 2_147_483_647) throw new RangeError('Tool model wait must be a nonnegative timer duration');
  const retained = Object.freeze({ id: reference.id, contract: reference.contract });
  const stop = new AbortController();
  const abort = () => stop.abort(operation.signal?.reason);
  const detach = operation.onClose((reason) => stop.abort(reason));
  operation.signal?.addEventListener('abort', abort, { once: true });
  if (operation.signal?.aborted) abort();
  try {
    const result = await channel.wait(retained, { waitMs, signal: stop.signal });
    if (result.kind === 'received') return result.feedback.payload;
    if (result.kind === 'unavailable') throw result.error;
    throw new ModelReplyPending(retained);
  } catch (error) {
    if (operation.signal?.aborted && error === operation.signal.reason) throw new InvocationCancelled(operation.signal);
    throw error;
  } finally {
    detach();
    operation.signal?.removeEventListener('abort', abort);
  }
}
