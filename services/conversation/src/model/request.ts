import type { InteractionReference } from '@capix/interaction';
import type { ResourcesOf } from '@capix/resources';
import { Group, Node } from '@capix/structure';
import { ModelInteractionResource, type ModelMessages } from './interaction.js';
import { requireString, requireText } from '../text.js';

/** A failed local read retains the exchange reference; it never implies that sending is safe again. */
export class ModelReplyPending extends Error {
  readonly reference: InteractionReference;

  constructor(reference: InteractionReference) {
    super('Model reply is still pending; read the same interaction later');
    this.name = 'ModelReplyPending';
    this.reference = Object.freeze({ ...reference });
  }
}

/** This node can also be called in a new scene to read a known exchange, without sending. */
export function createModelReplyNode(waitMs = 30_000) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 2_147_483_647) throw new RangeError('Model reply wait must be a nonnegative timer duration');
  const deps = { feedback: ModelInteractionResource.feedback.request() };
  return new Node<InteractionReference, string, ResourcesOf<typeof deps>, string>({
    name: 'read-model-reply',
    deps,
    output: { result: (value) => requireText(value, 'Model answer'), delta: (value) => requireString(value, 'Model preview') },
    async run(work) {
      const reply = await work.resources.feedback.follow({ reference: work.input, waitMs }, { delta: (item) => work.output.emit(item.value) });
      if (reply.kind === 'received') return reply.feedback.payload;
      if (reply.kind === 'unavailable') throw reply.error;
      throw new ModelReplyPending(work.input);
    },
  });
}

/** Ordinary composition: send exactly once, then accept one local read of that exchange. */
export function createInteractionAnswer(options: { readonly waitMs?: number } = {}) {
  const deps = { requests: ModelInteractionResource.start.request() };
  const send = new Node<ModelMessages, InteractionReference, ResourcesOf<typeof deps>>({
    name: 'start-model-request',
    deps,
    run: (work) => work.resources.requests.start(work.input),
  });
  const read = createModelReplyNode(options.waitMs);
  const answer = new Group<ModelMessages, string, {}, string>({ name: 'interaction-answer', output: { result: (value) => requireText(value, 'Model answer'), delta: (value) => requireString(value, 'Model preview') } }).add({ send, read });
  answer.run = async (work) => {
    const reference = await work.children.send.invoke(work.input);
    return work.children.read.invoke(reference, { delta: (value) => work.output.emit(value) });
  };
  return answer;
}
