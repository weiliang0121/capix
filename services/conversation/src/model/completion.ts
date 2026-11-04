import type { InteractionChannel, InteractionReference } from '@capix/interaction';
import type { ModelReply, ModelRequest } from '@capix/model-provider';
import { isDeepStrictEqual } from 'node:util';
import { ResourceOffer, type ResourceOperation, type ResourcesOf } from '@capix/resources';
import { Group, Node, checkpointPoint, childReference, type ChildCall, type GroupWork, type NodeWork, type ResumeWork, type CheckpointFacts } from '@capix/structure';
import { requireString } from '../text.js';
import { followModelFeedback, waitModelFeedback, type ModelFeedbackInput, type ModelProgressDelta, type ModelProgressInput } from './feedback.js';
import { ModelReplyPending } from './pending.js';
import { requireCompletionReply } from './completion-contract.js';
import { emptyCodec } from '../recovery/codecs.js';
import { modelReplyCodec, modelRequestCodec, referenceCodec } from '../recovery/model-codecs.js';

type CompletionChannel = InteractionChannel<ModelRequest, ModelReply, string>;

/** Start grants dispatch; feedback grants only consumption of a previously established reference. */
export const CompletionInteractionResource = Object.freeze({
  start: new ResourceOffer({
    name: 'conversation.completion.start',
    methods: {
      start(channel: CompletionChannel, request: ModelRequest) {
        return channel.start(request);
      },
    },
    observation: { methods: { start: { input: (request) => ({ messages: request.messages.length, stream: request.stream === true, responseFormat: request.responseFormat }), output: (reference) => reference } } },
  }),
  feedback: new ResourceOffer({
    name: 'conversation.completion.feedback',
    methods: {
      read(channel: CompletionChannel, reference: InteractionReference) {
        return channel.read(reference);
      },
      wait(channel: CompletionChannel, input: ModelFeedbackInput, operation: ResourceOperation) {
        return waitModelFeedback(channel, input, operation);
      },
      follow(channel: CompletionChannel, input: ModelProgressInput, operation: ResourceOperation<ModelProgressDelta>) {
        return followModelFeedback(channel, input, operation);
      },
    },
    observation: {
      methods: {
        read: { input: (reference) => reference, output: (reply) => ({ kind: reply.kind }) },
        wait: { input: (input) => input, output: (reply) => ({ kind: reply.kind }) },
        follow: { input: (input) => input, output: (reply) => ({ kind: reply.kind }) },
      },
    },
  }),
});

/** A separate sender lets a host receive the reference before starting a local read. */
export function createCompletionStartNode() {
  const deps = { requests: CompletionInteractionResource.start.request() };
  const established = checkpointPoint<'node', ModelRequest, InteractionReference>()({
    name: 'established',
    state: referenceCodec,
    references: {},
    resume: { run: (_work, reference) => reference },
  });
  return new Node<ModelRequest, InteractionReference, ResourcesOf<typeof deps>>({
    name: 'start-completion-request',
    deps,
    checkpoint: { key: 'conversation.completion-start', version: 1, input: modelRequestCodec, output: referenceCodec, points: [established] },
    async run(work) {
      const reference = await work.resources.requests.start(work.input);
      // Before this save the dispatch/reference handoff is unknown. A missing child
      // checkpoint must be rejected by recovery, never repaired by sending again.
      work.checkpoint?.({ point: established, state: reference, refs: {} });
      return reference;
    },
  });
}

/** Reading preserves the full reply, including unsuccessful finish reasons and empty text. */
export function createCompletionReplyNode(waitMs = 30_000) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 2_147_483_647) throw new RangeError('Completion reply wait must be a nonnegative timer duration');
  const deps = { feedback: CompletionInteractionResource.feedback.request() };
  const waiting = checkpointPoint<'node', InteractionReference, ModelReply, string>()({
    name: 'waiting',
    state: referenceCodec,
    references: {},
    check: (reference, facts) => {
      if (!isDeepStrictEqual(reference, facts.input)) throw new Error('Completion read changed its interaction reference');
    },
    resume: { deps, run: (work, reference) => receive(work, reference) },
  });
  const completed = checkpointPoint<'node', InteractionReference, ModelReply, string>()({
    name: 'completed',
    state: modelReplyCodec,
    references: {},
    resume: { run: (_work, reply) => reply },
  });
  type Work = NodeWork<InteractionReference, ModelReply, ResourcesOf<typeof deps>, string> | ResumeWork<'node', InteractionReference, ModelReply, ResourcesOf<typeof deps>, never, string>;
  async function receive(work: Pick<Work, 'resources' | 'output' | 'checkpoint'>, reference: InteractionReference): Promise<ModelReply> {
    const reply = await work.resources.feedback.follow({ reference, waitMs }, { delta: (item) => work.output.emit(item.value) });
    if (reply.kind === 'unavailable') throw reply.error;
    if (reply.kind !== 'received') throw new ModelReplyPending(reference);
    work.checkpoint?.({ point: completed, state: reply.feedback.payload, refs: {} });
    return reply.feedback.payload;
  }
  return new Node<InteractionReference, ModelReply, ResourcesOf<typeof deps>, string>({
    name: 'read-completion-reply',
    deps,
    output: { result: requireCompletionReply, delta: (value) => requireString(value, 'Completion preview') },
    checkpoint: { key: 'conversation.completion-reply', version: 1, input: referenceCodec, output: modelReplyCodec, points: [waiting, completed] },
    async run(work) {
      const reference = Object.freeze({ id: work.input.id, contract: work.input.contract });
      work.checkpoint?.({ point: waiting, state: reference, refs: {} });
      return receive(work, reference);
    },
  });
}

/** No hidden retry or independent lifetime is introduced by composing the send and read nodes. */
export function createInteractionCompletion(options: { readonly waitMs?: number } = {}) {
  const send = createCompletionStartNode();
  const read = createCompletionReplyNode(options.waitMs);
  type Member = typeof send | typeof read;
  type Work = GroupWork<ModelRequest, ModelReply, {}, Member, string> | ResumeWork<'group', ModelRequest, ModelReply, {}, Member, string>;
  const point = checkpointPoint<'group', ModelRequest, ModelReply, string>();
  const sending = point({
    name: 'sending',
    state: emptyCodec,
    references: { send: childReference(send) },
    check: (_state, facts) => {
      const child = facts.references.send;
      if (facts.children.values().length !== 1 || child.order !== 0 || child.key !== 'send' || child.returned || !isDeepStrictEqual(child.input, facts.input)) throw new Error('Completion send checkpoint changed its request');
    },
    resume: { uses: [send, read], run: (work, _state, refs) => receiveSend(work, work.children.resume(refs.send)) },
  });
  const reading = point({
    name: 'reading',
    state: emptyCodec,
    references: { send: childReference(send), read: childReference(read) },
    check: (_state, facts) => {
      const reference = sentReference(facts);
      const child = facts.references.read;
      if (facts.children.values().length !== 2 || child.order !== 1 || child.key !== 'read' || child.returned || !isDeepStrictEqual(child.input, reference)) throw new Error('Completion read checkpoint changed its fixed reference');
    },
    resume: { uses: [send, read], run: (work, _state, refs) => receiveRead(work, refs.send, work.children.resume(refs.read)) },
  });
  const completed = point({
    name: 'completed',
    state: modelReplyCodec,
    references: { send: childReference(send), read: childReference(read) },
    check: (reply, facts) => {
      const reference = sentReference(facts);
      const child = facts.references.read;
      if (facts.children.values().length !== 2 || child.order !== 1 || child.key !== 'read' || !isDeepStrictEqual(child.input, reference) || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isDeepStrictEqual(child.returned.output, reply) || !isDeepStrictEqual(child.reception.value, reply)) throw new Error('Completed model reply differs from its accepted read');
    },
    resume: { run: (_work, reply) => reply },
  });
  function sentReference(facts: CheckpointFacts<ModelRequest>): InteractionReference {
    const child = facts.children.requireUnique(send, { parentRound: 1 });
    if (child.order !== 0 || child.key !== 'send' || !isDeepStrictEqual(child.input, facts.input) || child.returned?.status !== 'succeeded' || child.reception.status !== 'accepted' || !isDeepStrictEqual(child.reception.value, child.returned.output)) throw new Error('Completion requires its exact accepted send reference');
    return child.returned.output;
  }
  async function receiveSend(work: Work, child: ChildCall<typeof send>): Promise<ModelReply> {
    const reference = await child.invoke();
    const feedback = work.children.create(read, reference, {
      key: 'read',
      output: {
        receive: (event) => {
          if (event.kind === 'delta') work.output.emit(event.delta);
        },
      },
    });
    work.checkpoint?.({ point: reading, state: {}, refs: { send: child.ref, read: feedback.ref } });
    return receiveRead(work, child.ref, feedback);
  }
  async function receiveRead(work: Work, sent: ChildCall<typeof send>['ref'], child: ChildCall<typeof read>): Promise<ModelReply> {
    const reply = await child.invoke();
    work.checkpoint?.({ point: completed, state: reply, refs: { send: sent, read: child.ref } });
    return reply;
  }
  const completion = new Group<ModelRequest, ModelReply, {}, string>({ name: 'interaction-completion', output: { result: requireCompletionReply, delta: (value) => requireString(value, 'Completion preview') } }).add({ send, read });
  completion.checkpoint = { key: 'conversation.interaction-completion', version: 1, input: modelRequestCodec, output: modelReplyCodec, points: [sending, reading, completed] };
  completion.run = (work) => {
    const child = work.children.create(send, work.input, { key: 'send' });
    work.checkpoint?.({ point: sending, state: {}, refs: { send: child.ref } });
    return receiveSend(work, child);
  };
  return completion;
}
