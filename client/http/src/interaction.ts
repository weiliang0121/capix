import { z } from 'zod';
import type { CallInteractionLinks, InteractionObservation } from '@capix/protocol';
import { acceptResponse, deliver, parseLine } from './responses.js';
import { HttpTransportError } from './errors.js';
import { readLines } from './stream.js';

const id = z.string().min(1);
export const interactionLinksResponse = z.strictObject({ callId: id, interactionIds: z.array(id).refine((ids) => new Set(ids).size === ids.length) }) satisfies z.ZodType<CallInteractionLinks>;
const observation = z.strictObject({
  id,
  contract: id,
  revision: z.int().nonnegative(),
  delivery: z.enum(['prepared', 'started']),
  retained: z.enum(['persistent', 'memory']),
  model: z.string(),
  purpose: z.string(),
  result: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('pending') }), z.strictObject({ kind: z.literal('received'), feedbackId: id }), z.strictObject({ kind: z.literal('unavailable'), error: z.strictObject({ code: id, message: z.string() }) })]),
}) satisfies z.ZodType<InteractionObservation>;
const update = z.discriminatedUnion('type', [z.strictObject({ type: z.literal('snapshot'), value: observation }), z.strictObject({ type: z.literal('error'), error: z.string(), code: id.optional() })]);

export async function consumeInteraction(stream: ReadableStream<Uint8Array>, expectedId: string, accept: (value: InteractionObservation) => void): Promise<void> {
  let terminal = false;
  for await (const line of readLines(stream)) {
    if (terminal) throw new HttpTransportError('contract', '交互观测在最终状态之后继续返回数据。', 'INTERACTION_TERMINATED');
    const frame = acceptResponse(update, parseLine(line), '交互观测');
    if (frame.type === 'error') throw new HttpTransportError('remote', frame.error, frame.code);
    if (frame.value.id !== expectedId) throw new HttpTransportError('contract', '交互观测身份与请求不一致。', 'INTERACTION_MISMATCH');
    terminal = frame.value.result.kind !== 'pending';
    deliver(() => accept(frame.value), '交互观测');
  }
  if (!terminal) throw new HttpTransportError('delivery', '交互观测在取得最终状态前中断。', 'INTERACTION_INTERRUPTED');
}
