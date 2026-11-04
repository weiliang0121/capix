import { isDeepStrictEqual } from 'node:util';
import { Group, checkpointPoint, childReference, type GroupWork, type CheckpointFacts } from '@capix/structure';
import type { AcceptedConversationMessage } from '../scene.js';
import { createMessageInclusion } from '../materials/maintenance.js';
import { createInteractionCompletion } from '../model/completion.js';
import { acceptedMessageCodec, voidCodec } from '../recovery/codecs.js';
import { createMemoryMaintenance } from './maintenance.js';

/** Default content policy: include the formal message, then maintain the memory collection. */
export function createContentMaintenance() {
  const include = createMessageInclusion();
  const remember = createMemoryMaintenance(createInteractionCompletion());
  function checkInclusion(facts: CheckpointFacts<AcceptedConversationMessage>) {
    const child = facts.children.requireUnique(include, { parentRound: 1 });
    if (child.key !== 'include' || child.order !== 0 || !isDeepStrictEqual(child.input, facts.input) || child.returned?.status !== 'succeeded' || child.returned.output !== undefined || child.reception.status !== 'accepted' || child.reception.value !== undefined) throw new Error('Content maintenance requires its exact accepted message inclusion');
  }
  const completed = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'completed',
    state: voidCodec,
    references: {},
    check(_state, facts) {
      checkInclusion(facts);
      const child = facts.children.requireUnique(remember, { parentRound: 1 });
      if (facts.children.values().length !== 2 || child.key !== 'remember' || child.order !== 1 || !isDeepStrictEqual(child.input, facts.input) || child.returned?.status !== 'succeeded' || child.returned.output !== undefined || child.reception.status !== 'accepted' || child.reception.value !== undefined) throw new Error('Content maintenance lacks its accepted memory maintenance');
    },
    resume: { run() {} },
  });
  const remembering = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'memoryWaiting',
    state: voidCodec,
    references: { remember: childReference(remember) },
    check(_state, facts) {
      checkInclusion(facts);
      const child = facts.references.remember;
      if (facts.children.values().length !== 2 || child.key !== 'remember' || child.order !== 1 || child.returned || !isDeepStrictEqual(child.input, facts.input)) throw new Error('Content maintenance changed its pending memory call');
    },
    resume: {
      uses: [remember],
      async run(work, _state, refs) {
        await work.children.resume(refs.remember).invoke();
        work.checkpoint?.({ point: completed, state: undefined, refs: {} });
      },
    },
  });
  async function maintain(work: GroupWork<AcceptedConversationMessage, void, {}, typeof remember>) {
    const call = work.children.create(remember, work.input, { key: 'remember' });
    work.checkpoint?.({ point: remembering, state: undefined, refs: { remember: call.ref } });
    await call.invoke();
    work.checkpoint?.({ point: completed, state: undefined, refs: {} });
  }
  const included = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'messageIncluded',
    state: voidCodec,
    references: {},
    check(_state, facts) {
      checkInclusion(facts);
      if (facts.children.values().length !== 1) throw new Error('Included content checkpoint has an unexpected child');
    },
    resume: { uses: [remember], run: maintain },
  });
  const including = checkpointPoint<'group', AcceptedConversationMessage, void>()({
    name: 'messageWaiting',
    state: voidCodec,
    references: { include: childReference(include) },
    check(_state, facts) {
      const child = facts.references.include;
      if (facts.children.values().length !== 1 || child.key !== 'include' || child.order !== 0 || child.returned || !isDeepStrictEqual(child.input, facts.input)) throw new Error('Content maintenance changed its pending inclusion');
    },
    resume: {
      uses: [include, remember],
      async run(work, _state, refs) {
        await work.children.resume(refs.include).invoke();
        work.checkpoint?.({ point: included, state: undefined, refs: {} });
        await maintain(work);
      },
    },
  });
  const content = new Group<AcceptedConversationMessage, void>({
    name: 'maintain-conversation-content',
    checkpoint: { key: 'conversation.content.maintenance', version: 1, input: acceptedMessageCodec, output: voidCodec, points: [including, included, remembering, completed] },
  }).add({ include, remember });
  content.run = async (work) => {
    const call = work.children.create(include, work.input, { key: 'include' });
    work.checkpoint?.({ point: including, state: undefined, refs: { include: call.ref } });
    await call.invoke();
    work.checkpoint?.({ point: included, state: undefined, refs: {} });
    await maintain(work);
  };
  return content;
}
