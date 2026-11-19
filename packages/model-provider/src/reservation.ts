import type { ModelMessage, ModelRequest, ModelRequestReservation } from './types.js';
import { count, requireJson, shape } from './value.js';

// The shortest admitted image is a six-byte JPEG (eight padded base64
// characters). PNG and WebP need longer headers even after MIME encoding.
const minimumImageBytes = Buffer.byteLength(JSON.stringify({ kind: 'image', mimeType: 'image/jpeg', data: '/9j/AP/Z' }));

/** Maximum image parts fitting one complete common feedback, including identity and commas. */
export function maximumFeedbackImages(toolCallId: string, maxBytes: number): number {
  if (typeof toolCallId !== 'string' || !toolCallId.length || toolCallId.length > 256 || !count(maxBytes)) throw new TypeError('Invalid feedback image budget');
  const envelope = Buffer.byteLength(JSON.stringify({ toolCallId, status: 'ok', content: [] }));
  return Math.max(0, Math.min(32, Math.floor((maxBytes - envelope + 1) / (minimumImageBytes + 1))));
}

function feedbackGrowth(request: ModelRequest, reservation: ModelRequestReservation, perCall?: (growth: number, id: string, images: number, textParts: number) => number): number {
  requireJson(reservation);
  shape(reservation, ['feedback', 'contextGrowthBytes'], ['imageOmissionBytes', 'imageOmissionByExchange', 'mutableContext']);
  if ((reservation.imageOmissionBytes !== undefined && !count(reservation.imageOmissionBytes)) || !count(reservation.contextGrowthBytes) || !Array.isArray(reservation.feedback) || reservation.feedback.length > 32) throw new TypeError('Invalid model wire reservation');
  if (reservation.mutableContext !== undefined && reservation.mutableContext !== true) throw new TypeError('Invalid mutable context reservation');
  const omissions = reservation.imageOmissionByExchange;
  if (omissions !== undefined && (!Array.isArray(omissions) || omissions.length !== (request.exchanges?.length ?? 0) || !omissions.every(count) || omissions.reduce((sum, bytes) => sum + bytes, 0) !== (reservation.imageOmissionBytes ?? 0))) throw new TypeError('Invalid per-exchange image omission reservation');
  const placeholders = new Map(request.exchanges?.at(-1)?.feedback.map((feedback) => [feedback.toolCallId, feedback]));
  let total = 0;
  for (const slot of reservation.feedback) {
    shape(slot, ['toolCallId', 'maxBytes']);
    if (typeof slot.toolCallId !== 'string' || !count(slot.maxBytes)) throw new TypeError('Invalid model feedback reservation');
    const placeholder = placeholders.get(slot.toolCallId);
    if (!placeholder || placeholder.status !== 'ok' || placeholder.content.some((part) => part.kind !== 'text' || part.text !== '')) throw new TypeError('A model feedback reservation requires a distinct empty placeholder');
    placeholders.delete(slot.toolCallId);
    const growth = slot.maxBytes - Buffer.byteLength(JSON.stringify(placeholder));
    if (growth < 0) throw new RangeError('Feedback reservation is smaller than its placeholder');
    if (perCall) total += perCall(growth, slot.toolCallId, maximumFeedbackImages(slot.toolCallId, slot.maxBytes), placeholder.content.length);
  }
  return total;
}

/** Validate slot identities and future projection metadata without choosing a wire encoding. */
export function checkModelReservation(request: ModelRequest, reservation: ModelRequestReservation): void {
  feedbackGrowth(request, reservation);
}

function bounded(total: number): number {
  if (!count(total)) throw new RangeError('Model wire reservation exceeds safe integer range');
  return total;
}

type ContextProtocol = 'chat' | 'messages' | 'responses' | 'gemini';

// Marginal wire bytes minus marginal common bytes for one existing message.
// Payloads have the same JSON escaping. Only fixed field names, wrappers and
// separators differ. Messages and Gemini combine all leading system messages.
function contextOverhead(protocol: ContextProtocol, message: ModelMessage, otherSystem: boolean): number {
  const { role, content } = message;
  const string = typeof content === 'string';
  const texts = string ? 0 : content.filter((part) => part.kind === 'text').length;
  const images = string ? 0 : content.length - texts;
  switch (protocol) {
    case 'chat':
      return 16 * images; // image_url
    case 'responses':
      return 6 * texts + 26 * images; // input_text and input_image
    case 'messages':
      if (role !== 'system') return 29 * images; // base64 source
      return (otherSystem ? -5 : 6) - (string ? 0 : 25);
    case 'gemini': {
      // A string gets a one-part text wrapper. Arrays already have brackets,
      // drop "kind":"text", and inlineData has the common image's size.
      const wrapper = role === 'system' ? (otherSystem ? -19 : 13) : role === 'assistant' ? 5 : 9;
      return wrapper - (string ? 0 : 11 + 14 * texts);
    }
  }
}

function maximumContextOverhead(protocol: ContextProtocol, bytes: number, otherSystem: boolean): number {
  // Includes the outer message separator. A user text string fits in 29
  // bytes; the first system string needs 31 and introduces a wire field.
  if (bytes < 29) return 0;
  const firstSystem = !otherSystem && bytes >= 31;
  if (protocol === 'gemini') return firstSystem ? 13 : 9;
  // The smallest user message with an array costs 28 bytes plus 26 per
  // empty text or 59 per minimum JPEG (including each part's separator).
  const partsBudget = bytes - 28;
  const images = Math.min(32, Math.floor(partsBudget / (minimumImageBytes + 1)));
  if (protocol === 'messages') return Math.max(firstSystem ? 6 : 0, 29 * images);
  if (protocol === 'chat') return 16 * images;
  // One Responses image costs fewer bytes than three texts and adds more
  // overhead, so maximize images first, then fill remaining room with text.
  const texts = Math.min(32 - images, Math.floor((partsBudget - images * (minimumImageBytes + 1)) / 26));
  return 26 * images + 6 * texts;
}

function contextWireGrowth(protocol: ContextProtocol, request: ModelRequest, reservation: ModelRequestReservation): number {
  const growth = reservation.contextGrowthBytes;
  if (!growth && !reservation.mutableContext) return 0;
  const systems = request.messages.filter((message) => message.role === 'system').length;
  let extra = maximumContextOverhead(protocol, growth, systems > 0);
  // The reservation identifies no particular slot. Bound inserting a new
  // message or replacing any one admitted message, even at zero common growth.
  for (const message of request.messages) {
    const otherSystem = systems > (message.role === 'system' ? 1 : 0);
    const bytes = Buffer.byteLength(JSON.stringify(message)) + 1 + growth;
    extra = Math.max(extra, maximumContextOverhead(protocol, bytes, otherSystem) - contextOverhead(protocol, message, otherSystem));
  }
  return growth + extra;
}

export function reserveChatWireBytes(wireBytes: number, request: ModelRequest, reservation: ModelRequestReservation): number {
  // Tool text is JSON inside a JSON string. Each image adds an index reference,
  // its attachment and label; each result may introduce an escaped call identity.
  const growth = feedbackGrowth(request, reservation, (bytes, id, images, textParts) => {
    // Replacing empty text envelopes with escaped text can reclaim up to 26
    // common bytes per part. An image's two attachment blocks and reference
    // cost at most 64 bytes beyond twice its common bytes (largest index 31).
    // The existing 128-byte allowance per image covers both terms for full batches.
    const parts = Math.max(images * 128, textParts * 26 + images * 64);
    return 2 * bytes + parts + (images ? 2 * Buffer.byteLength(JSON.stringify(id)) + 128 : 0);
  });
  // Preserve the existing double-growth allowance used by Tool preflight.
  const context = Math.max(2 * reservation.contextGrowthBytes, contextWireGrowth('chat', request, reservation));
  return bounded(wireBytes + growth + context + 2 * (reservation.imageOmissionBytes ?? 0));
}

export function reserveMessagesWireBytes(wireBytes: number, request: ModelRequest, reservation: ModelRequestReservation): number {
  // Text is escaped once in both representations. A base64 source object adds
  // fewer than 64 bytes per image; the ID, result block and user envelope are
  // already present. The extra byte covers the longer 'false' boolean.
  const growth = feedbackGrowth(request, reservation, (bytes, _id, images) => bytes + images * 64 + 1);
  return bounded(wireBytes + growth + contextWireGrowth('messages', request, reservation) + (reservation.imageOmissionBytes ?? 0));
}

export function reserveResponsesWireBytes(wireBytes: number, request: ModelRequest, reservation: ModelRequestReservation): number {
  // Text is escaped once in both forms. 'input_text' costs six extra bytes
  // per new part; each extra empty text part costs at least 26 common bytes.
  // The image URL + detail field costs less than 64 beyond a common image.
  const growth = feedbackGrowth(request, reservation, (bytes, _id, images, textParts) => bytes + 6 * Math.min(32 - textParts, Math.floor(bytes / 26)) + 64 * images);
  return bounded(wireBytes + growth + contextWireGrowth('responses', request, reservation) + (reservation.imageOmissionBytes ?? 0));
}

export function reserveGeminiWireBytes(wireBytes: number, request: ModelRequest, reservation: ModelRequestReservation): number {
  // Text parts have identical JSON in the result object and the common value.
  // Each image adds an inlineData part, a matching image-N label and reference (0..31)
  // and possibly the parts array; together these add fewer than 64 bytes.
  const growth = feedbackGrowth(request, reservation, (bytes, _id, images) => bytes + 64 * images);
  return bounded(wireBytes + growth + contextWireGrowth('gemini', request, reservation) + (reservation.imageOmissionBytes ?? 0));
}
