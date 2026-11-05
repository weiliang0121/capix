import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { ResourceOffer } from '@capix/resources';
import { validateReply, acceptFeedback } from './protocol.mjs';
import { canonical, collectionLimit, fixed } from './value.mjs';

export const feedbackDigest = (value) => createHash('sha256').update(canonical(value)).digest('hex');

const identity = z.string().min(1).max(256);
const operationSchema = z.strictObject({ parentContextId: identity, childContextId: identity, position: identity });
const referenceSchema = z.strictObject({ collection: identity, id: identity, revision: z.number().int().nonnegative() });
const entrySchema = z.strictObject({ id: identity, revision: z.number().int().nonnegative(), scope: identity, operation: operationSchema, reply: z.unknown(), feedback: z.array(z.unknown()).max(32), receptions: z.array(z.strictObject({ callId: identity, operation: operationSchema })).max(32) });
const snapshotSchema = z.strictObject({ id: identity, entries: z.array(entrySchema) });

/** Example-only entity: protocol slots are facts, never a second invocation state. */
export class ModelExchanges {
  id = randomUUID();
  #entries = new Map();
  #receipts = new Map();

  intake(scope, operation, reply) {
    identity.parse(scope);
    operation = operationSchema.parse(fixed(operation));
    const accepted = validateReply(reply);
    const key = canonical(operation);
    const previous = this.#receipts.get(key);
    if (previous) {
      const entry = this.#entries.get(previous);
      if (entry.scope !== scope || !equal(entry.reply, accepted)) throw new Error('Exchange intake conflicts with its fixed receipt');
      return this.ref(entry);
    }
    const entry = fixed({ id: randomUUID(), revision: 0, scope, operation, reply: accepted, feedback: [], receptions: [] }, collectionLimit);
    this.#entries.set(entry.id, entry);
    this.#receipts.set(key, entry.id);
    return this.ref(entry);
  }

  complete(scope, ref, callId, result, operation) {
    if (operation !== undefined) operation = operationSchema.parse(fixed(operation));
    const entry = this.read(scope, ref, false);
    if (!entry.reply.output.some((item) => item.kind === 'tool-call' && item.id === callId)) throw new Error('Unknown tool feedback slot');
    const feedback = acceptFeedback(callId, result);
    const previous = entry.feedback.find((item) => item.toolCallId === callId);
    if (previous) {
      if (!equal(previous, feedback) || !equal(entry.receptions.find((item) => item.callId === callId)?.operation, operation)) throw new Error('Tool feedback conflicts with its fixed slot');
      return this.ref(entry);
    }
    const next = fixed({ ...entry, revision: entry.revision + 1, feedback: [...entry.feedback, feedback], receptions: operation ? [...entry.receptions, { callId, operation }] : entry.receptions }, collectionLimit);
    this.#entries.set(next.id, next);
    return this.ref(next);
  }

  read(scope, ref, exact = true) {
    ref = referenceSchema.parse(fixed(ref));
    const entry = this.#entries.get(ref?.id);
    if (ref?.collection !== this.id || !entry || entry.scope !== scope || !Number.isSafeInteger(ref.revision) || ref.revision < 0 || ref.revision > entry.revision || (exact && ref.revision !== entry.revision)) throw new Error('Exchange reference scope or revision mismatch');
    return entry;
  }

  closed(scope, refs) {
    refs = z.array(referenceSchema).parse(fixed(refs));
    const seen = new Set();
    return refs.map((ref) => {
      if (seen.has(ref.id)) throw new Error('Duplicate exchange reference');
      seen.add(ref.id);
      const entry = this.read(scope, ref);
      const calls = entry.reply.output.filter((item) => item.kind === 'tool-call');
      if (calls.length !== entry.feedback.length) throw new Error('Exchange is missing tool feedback');
      return entry;
    });
  }

  ref(entry) {
    return fixed({ collection: this.id, id: entry.id, revision: entry.revision });
  }

  snapshot() {
    return fixed({ id: this.id, entries: [...this.#entries.values()] }, collectionLimit);
  }

  static restore(snapshot) {
    snapshot = snapshotSchema.parse(fixed(snapshot, collectionLimit));
    const entity = new ModelExchanges();
    entity.id = snapshot.id;
    for (const item of snapshot.entries) {
      const reply = validateReply(item.reply);
      const calls = reply.output.filter((entry) => entry.kind === 'tool-call');
      const feedback = item.feedback.map(({ toolCallId, ...result }) => acceptFeedback(toolCallId, result));
      if (entity.#entries.has(item.id) || new Set(feedback.map((entry) => entry.toolCallId)).size !== feedback.length || feedback.some((entry) => !calls.some((call) => call.id === entry.toolCallId)) || item.revision !== feedback.length) throw new Error('Invalid saved exchange slots');
      const key = canonical(item.operation);
      if (entity.#receipts.has(key)) throw new Error('Duplicate exchange receipt');
      if (!Array.isArray(item.receptions) || new Set(item.receptions.map((value) => value.callId)).size !== item.receptions.length || item.receptions.some((value) => !feedback.some((entry) => entry.toolCallId === value.callId) || typeof value.operation?.parentContextId !== 'string' || typeof value.operation?.childContextId !== 'string')) throw new Error('Invalid saved feedback provenance');
      entity.#entries.set(item.id, fixed({ ...item, reply, feedback }, collectionLimit));
      entity.#receipts.set(key, item.id);
    }
    return entity;
  }
}

export const ExchangeResource = new ResourceOffer({
  name: 'example.native-tools.exchanges',
  expose: ({ exchanges, scope }, activity) => ({
    intake(reply) {
      return activity.runSync('intake', {}, () => {
        const operation = { ...activity.reception(), position: 'model-reply' };
        return fixed({ reference: exchanges.intake(scope, operation, reply), operation });
      });
    },
    read(ref) {
      return activity.runSync('read', {}, () => exchanges.read(scope, ref, false));
    },
    closed(refs) {
      return activity.runSync('closed', {}, () => exchanges.closed(scope, refs));
    },
    receive(ref, callId, feedback) {
      return activity.runSync('receive', {}, () => {
        const operation = { ...activity.reception(), position: 'tool-feedback' };
        const reference = exchanges.complete(scope, ref, callId, feedback, operation);
        const value = exchanges.read(scope, reference).feedback.find((item) => item.toolCallId === callId);
        return fixed({ reference, operation, feedbackDigest: feedbackDigest(value) });
      });
    },
    complete(ref, callId, feedback) {
      return activity.runSync('complete', {}, () => exchanges.complete(scope, ref, callId, feedback));
    },
  }),
});
