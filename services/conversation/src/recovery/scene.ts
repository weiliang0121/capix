import type { Stable } from '@capix/contracts';
import { resolveConversationOutputBudget, type ConversationOutputBudget } from '../model/budget.js';
import { isDeepStrictEqual as equal } from 'node:util';
import type { ResourcesOf } from '@capix/resources';
import { Scene, checkpointPoint, childReference, reception, type ChildCall, type CheckpointFacts, type SceneWork } from '@capix/structure';
import { TranscriptResource } from '@capix/transcript';
import { z } from 'zod';
import type { ConversationMaterialInput } from '../materials/input.js';
import type { AcceptedConversationMessage, ConversationAnswer, ConversationMaintenance, ConversationPreparation } from '../scene.js';
import { requireString, requireText } from '../text.js';
import { ConversationRecoveryResource, conversationCheckpointKey, recoveryBasisSchema, type ConversationRecoveryBasis } from './basis.js';
import { acceptedMessageCodec, acceptedMessageSchema, codec, stringCodec } from './codecs.js';
import { materialInputSchema } from './model-codecs.js';
import type { JsonObject } from '@capix/model-provider';

/** Recovery is a default service policy. Arbitrary custom Scene strategies retain their own contracts. */
export function createRecoverableConversationScene(answer: ConversationAnswer<ConversationMaterialInput>, prepare: ConversationPreparation<ConversationMaterialInput>, maintain: ConversationMaintenance, outputBudget: ConversationOutputBudget) {
  return createContentRecoveryScene(answer, prepare, maintain, outputBudget, { key: conversationCheckpointKey, version: 3 });
}

/** Shared formal-message and maintenance lifecycle; each host supplies its own fixed root contract. */
export function createContentRecoveryScene(answer: ConversationAnswer<ConversationMaterialInput>, prepare: ConversationPreparation<ConversationMaterialInput>, maintain: ConversationMaintenance, outputBudget: ConversationOutputBudget, contract: { readonly key: string; readonly version: number; readonly policy?: JsonObject }) {
  const budget = resolveConversationOutputBudget(outputBudget);
  const policy = contract.policy === undefined ? undefined : structuredClone(contract.policy);
  const fixedState = { outputBudget: budget, ...(policy === undefined ? {} : { policy }) };
  const deps = { messages: TranscriptResource.append.request(), recovery: ConversationRecoveryResource.request() };
  type Work = SceneWork<string, string, ResourcesOf<typeof deps>, typeof answer | typeof prepare | typeof maintain, string>;
  const baseState = z.strictObject({ basis: recoveryBasisSchema, outputBudget: z.strictObject({ answer: z.literal(budget.answer), memory: z.literal(budget.memory) }), ...(policy === undefined ? {} : { policy: z.custom<JsonObject>((value) => equal(value, policy), 'Conversation root policy changed') }) });
  const answerState = baseState.extend({ input: materialInputSchema });
  const finishedState = baseState.extend({ response: acceptedMessageSchema });
  const answerReception = reception(answer, { ...acceptedMessageCodec, check: (value: unknown) => acceptedMessageSchema.parse(value) });
  const point = checkpointPoint<'scene', string, string, string>();

  function checkBasis(basis: Stable<ConversationRecoveryBasis>, facts: CheckpointFacts<string>): void {
    if (facts.input !== basis.accepted.message.content || basis.accepted.message.role !== 'user' || basis.accepted.index + 1 !== basis.transcript.end) throw new Error('Scene checkpoint changed its formal input');
  }
  function checkedPrepared(facts: CheckpointFacts<string>, basis: Stable<ConversationRecoveryBasis>): ConversationMaterialInput {
    checkBasis(basis, facts);
    const before = facts.children.list(maintain).find((child) => child.key === 'before');
    const preparation = facts.children.requireUnique(prepare, { parentRound: 1 });
    if (!before || before.order !== 0 || before.reception.status !== 'accepted' || before.returned?.status !== 'succeeded' || !equal(before.input, basis.accepted) || preparation.order !== 1 || preparation.key !== 'prepare' || !equal(preparation.input, basis.accepted) || preparation.reception.status !== 'accepted' || preparation.returned?.status !== 'succeeded' || !equal(preparation.reception.value, preparation.returned.output)) throw new Error('Scene preparation lacks its accepted predecessor');
    return preparation.returned.output;
  }
  function checkedResponse(facts: CheckpointFacts<string>, basis: Stable<ConversationRecoveryBasis>): AcceptedConversationMessage {
    const input = checkedPrepared(facts, basis);
    const child = facts.children.requireUnique(answer, { parentRound: 1 });
    const response = facts.children.accepted(child.ref, answerReception);
    if (child.key !== 'answer' || child.order !== 2 || !equal(child.input, input) || child.returned?.status !== 'succeeded' || response.transcriptId !== basis.accepted.transcriptId || response.index !== basis.transcript.end || response.message.role !== 'assistant' || response.message.content !== child.returned.output) throw new Error('Scene response differs from its accepted answer');
    return response;
  }
  const beforeWaiting = point({
    name: 'beforeWaiting',
    state: codec(baseState),
    references: { child: childReference(maintain) },
    check: ({ basis }, facts) => {
      checkBasis(basis, facts);
      const child = facts.references.child;
      if (facts.children.values().length !== 1 || child.key !== 'before' || child.order !== 0 || child.returned || !equal(child.input, basis.accepted)) throw new Error('Scene must wait for its first input maintenance');
    },
    resume: {
      deps,
      uses: [answer, prepare, maintain],
      async run(work, { basis }, refs) {
        await work.children.resume(refs.child).invoke();
        return prepareInput(work, basis);
      },
    },
  });
  const prepareWaiting = point({
    name: 'prepareWaiting',
    state: codec(baseState),
    references: { child: childReference(prepare) },
    check: ({ basis }, facts) => {
      checkBasis(basis, facts);
      const before = facts.children.requireUnique(maintain, { parentRound: 1 });
      const child = facts.references.child;
      if (facts.children.values().length !== 2 || before.key !== 'before' || before.reception.status !== 'accepted' || !equal(before.input, basis.accepted) || child.key !== 'prepare' || child.order !== 1 || child.returned || !equal(child.input, basis.accepted)) throw new Error('Scene must prepare its exact accepted input');
    },
    resume: { deps, uses: [answer, prepare, maintain], run: (work, { basis }, refs) => receivePreparation(work, basis, work.children.resume(refs.child)) },
  });
  const answerWaiting = point({
    name: 'answerWaiting',
    state: codec(answerState),
    references: { child: childReference(answer) },
    check: ({ basis, input }, facts) => {
      const prepared = checkedPrepared(facts, basis);
      const child = facts.references.child;
      if (facts.children.values().length !== 3 || child.key !== 'answer' || child.order !== 2 || child.returned || !equal(input, prepared) || !equal(child.input, input)) throw new Error('Scene answer changed its fixed material');
    },
    resume: { deps, uses: [answer, prepare, maintain], run: (work, { basis }, refs) => receiveAnswer(work, basis, work.children.resume(refs.child)) },
  });
  const answerAccepted = point({
    name: 'answerAccepted',
    state: codec(finishedState),
    references: { child: childReference(answer) },
    check: ({ basis, response }, facts) => {
      if (facts.children.values().length !== 3 || !equal(response, checkedResponse(facts, basis))) throw new Error('Scene accepted response does not match its child');
    },
    resume: { deps, uses: [maintain], run: (work, { basis, response }) => maintainAnswer(work, basis, response) },
  });
  const afterWaiting = point({
    name: 'afterWaiting',
    state: codec(finishedState),
    references: { child: childReference(maintain) },
    check: ({ basis, response }, facts) => {
      const child = facts.references.child;
      if (facts.children.values().length !== 4 || !equal(response, checkedResponse(facts, basis)) || child.key !== 'after' || child.order !== 3 || child.returned || !equal(child.input, response)) throw new Error('Scene final maintenance changed its accepted response');
    },
    resume: {
      deps,
      uses: [maintain],
      async run(work, { basis, response }, refs) {
        await work.children.resume(refs.child).invoke();
        return complete(work, basis, response, refs.child);
      },
    },
  });
  const completed = point({
    name: 'completed',
    state: codec(finishedState),
    references: { child: childReference(maintain) },
    check: ({ basis, response }, facts) => {
      const child = facts.references.child;
      if (facts.children.values().length !== 4 || !equal(response, checkedResponse(facts, basis)) || child.key !== 'after' || child.reception.status !== 'accepted' || child.returned?.status !== 'succeeded' || !equal(child.input, response)) throw new Error('Scene completion lacks its accepted maintenance');
    },
    resume: { run: (_work, { response }) => response.message.content },
  });
  async function prepareInput(work: Work, basis: Stable<ConversationRecoveryBasis>): Promise<string> {
    const child = work.children.create(prepare, basis.accepted, { key: 'prepare' });
    work.checkpoint?.({ point: prepareWaiting, state: { ...fixedState, basis }, refs: { child: child.ref } });
    return receivePreparation(work, basis, child);
  }
  async function receivePreparation(work: Work, basis: Stable<ConversationRecoveryBasis>, child: ChildCall<typeof prepare>): Promise<string> {
    const input = await child.invoke();
    const next = work.children.create(answer, input, {
      key: 'answer',
      output: {
        receive(event) {
          if (event.kind === 'delta') work.output.emit(event.delta);
        },
      },
    });
    work.checkpoint?.({ point: answerWaiting, state: { ...fixedState, basis, input }, refs: { child: next.ref } });
    return receiveAnswer(work, basis, next);
  }
  async function receiveAnswer(work: Work, basis: Stable<ConversationRecoveryBasis>, child: ChildCall<typeof answer>): Promise<string> {
    const response = await child.invoke({
      reception: answerReception,
      result: {
        succeeded(content) {
          requireText(content, 'Conversation answer');
          if (!work.checkpoint) {
            const [accepted] = work.resources.messages.append([{ role: 'assistant', content }]);
            if (!accepted) throw new Error('Missing accepted answer');
            return accepted;
          }
          const receipt = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] });
          return { transcriptId: receipt.transcriptId, index: receipt.start, message: { role: 'assistant' as const, content } };
        },
      },
    });
    work.checkpoint?.({ point: answerAccepted, state: { ...fixedState, basis, response }, refs: { child: child.ref } });
    return maintainAnswer(work, basis, response);
  }
  async function maintainAnswer(work: Pick<Work, 'children' | 'checkpoint'>, basis: Stable<ConversationRecoveryBasis>, response: AcceptedConversationMessage): Promise<string> {
    const child = work.children.create(maintain, response, { key: 'after' });
    work.checkpoint?.({ point: afterWaiting, state: { ...fixedState, basis, response }, refs: { child: child.ref } });
    await child.invoke();
    return complete(work, basis, response, child.ref);
  }
  function complete(work: Pick<Work, 'checkpoint'>, basis: Stable<ConversationRecoveryBasis>, response: AcceptedConversationMessage, ref: ChildCall<typeof maintain>['ref']): string {
    work.checkpoint?.({ point: completed, state: { ...fixedState, basis, response }, refs: { child: ref } });
    return response.message.content;
  }
  const scene = new Scene<string, string, ResourcesOf<typeof deps>, string>({ name: 'conversation', deps, output: { result: (value) => requireText(value, 'Conversation answer'), delta: (value) => requireString(value, 'Conversation delta') } }).add({ prepare, answer, maintain });
  scene.checkpoint = { key: contract.key, version: contract.version, input: stringCodec, output: stringCodec, points: [beforeWaiting, prepareWaiting, answerWaiting, answerAccepted, afterWaiting, completed], receptions: [answerReception] };
  scene.run = async (work) => {
    const [accepted] = work.resources.messages.append([{ role: 'user', content: requireText(work.input, 'Conversation input') }]);
    if (!accepted) throw new Error('Missing accepted input');
    const basis = work.resources.recovery.capture(accepted);
    const child = work.children.create(maintain, accepted, { key: 'before' });
    work.checkpoint?.({ point: beforeWaiting, state: { ...fixedState, basis }, refs: { child: child.ref } });
    await child.invoke();
    return prepareInput(work, basis);
  };
  return scene;
}
