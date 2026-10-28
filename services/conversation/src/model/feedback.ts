import type { InteractionChannel, InteractionCursor, InteractionWait } from '@capix/interaction';
import type { ResourceOperation } from '@capix/resources';
import { InvocationCancelled } from '@capix/server-runtime';
import type { ModelMessages } from './interaction.js';

type ModelChannel = InteractionChannel<ModelMessages, string, string>;

export interface ModelFeedbackInput {
  readonly reference: Parameters<ModelChannel['read']>[0];
  readonly waitMs: number;
}

export interface ModelProgressInput extends ModelFeedbackInput {
  readonly after?: InteractionCursor;
}

/** A sequence position identifies delivery, not successful decoding, display or acceptance. */
export interface ModelProgressDelta {
  readonly cursor: InteractionCursor;
  readonly value: string;
}

/** Stop only local consumption, preserving the original call signal and its exact reason. */
function localWait(operation: ResourceOperation) {
  const stop = new AbortController();
  const cancel = () => stop.abort(operation.signal?.reason);
  const detach = operation.onClose((reason) => stop.abort(reason));
  operation.signal?.addEventListener('abort', cancel, { once: true });
  if (operation.signal?.aborted) cancel();
  return {
    signal: stop.signal,
    close() {
      detach();
      operation.signal?.removeEventListener('abort', cancel);
    },
  };
}

function rethrow(error: unknown, operation: ResourceOperation): never {
  if (operation.signal?.aborted && error === operation.signal.reason) throw new InvocationCancelled(operation.signal);
  throw error;
}

export async function waitModelFeedback(channel: ModelChannel, input: ModelFeedbackInput, operation: ResourceOperation): Promise<InteractionWait<string>> {
  const local = localWait(operation);
  try {
    return await channel.wait(input.reference, { waitMs: input.waitMs, signal: local.signal });
  } catch (error) {
    return rethrow(error, operation);
  } finally {
    local.close();
  }
}

/** Consume the preview within this operation, then read the independently validated reply. */
export async function followModelFeedback(channel: ModelChannel, input: ModelProgressInput, operation: ResourceOperation<ModelProgressDelta>): Promise<InteractionWait<string>> {
  if (!Number.isSafeInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 2_147_483_647) throw new RangeError('Model reply wait must be a nonnegative timer duration');
  const reference = Object.freeze({ id: input.reference.id, contract: input.reference.contract });
  const deadline = performance.now() + input.waitMs;
  const remaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
  const local = localWait(operation);
  let reader: ReturnType<ModelChannel['openProgress']> | undefined;
  const closeReader = () => reader?.close(local.signal.reason);
  try {
    reader = channel.openProgress(reference, input.after);
    local.signal.addEventListener('abort', closeReader, { once: true });
    if (local.signal.aborted) closeReader();
    while (remaining() > 0) {
      const item = await reader.next({ waitMs: remaining(), signal: local.signal });
      if (item.kind !== 'item') break;
      operation.emit(Object.freeze({ cursor: item.cursor, value: item.value }));
    }
    // Sealed preview does not prove a reply exists; unavailable preview does not invalidate it.
    return await channel.wait(reference, { waitMs: remaining(), signal: local.signal });
  } catch (error) {
    return rethrow(error, operation);
  } finally {
    local.signal.removeEventListener('abort', closeReader);
    reader?.close();
    local.close();
  }
}
