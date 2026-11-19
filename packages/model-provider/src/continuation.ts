import { assertModelRequestNodeCapacity } from './contract.js';
import { ProviderError } from './error.js';
import { nativeReplyProtocol } from './native-reply.js';
import { checkModelReservation } from './reservation.js';
import type { ModelRequest, ModelRequestReservation } from './types.js';

/** Check a proposed continuation against saved facts before effects, independently of the active sender. */
export function assertModelContinuation(request: ModelRequest, reservation?: ModelRequestReservation, additionalNodes = 0): void {
  assertModelRequestNodeCapacity(request, additionalNodes);
  if (reservation !== undefined) checkModelReservation(request, reservation);
  const history = request.exchanges;
  const native = history?.[0]?.reply.native;
  if (!history || !native) return;
  if (history.some(({ reply }) => reply.native.format !== native.format)) throw new ProviderError('REQUEST', 'Cannot continue a history containing different native formats');
  nativeReplyProtocol(native).assertContinuation?.(request, reservation);
}
