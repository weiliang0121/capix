import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationInteractions, createConversationResources, createMaterialConversationScene } from '@capix/conversation-service/assembly';
import { createConversationRecording } from '@capix/conversation-service/recording';
import { CallableRecord, RecordBook, Recorder } from '@capix/records';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { View } from '@capix/view';
import { Node, Scene } from '@capix/structure';
import { Resources, Runner } from '@capix/server-runtime';

const preview = 'PREVIEW_ONLY_NOT_FORMAL_CONTENT';
const reply = (text) => ({ id: 'recording-offline', model: 'fixture', text, finishReason: 'stop', usage: null });

function modelFixture({ answer, propose } = {}) {
  const requests = [];
  return {
    requests,
    async complete(request, controls = {}) {
      requests.push(request);
      const input = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      if (request.responseFormat === 'text') {
        if (answer) return answer(input, controls);
        controls.emit?.(preview);
        return reply(`Formal answer: ${input.query.content}`);
      }
      if (propose) return propose(input);
      const latest = input.messages.findLast(({ message }) => message.role === 'user');
      const previous = input.memories[0];
      return reply(JSON.stringify({ changes: [{ action: previous ? 'update' : 'create', memoryId: previous?.id ?? null, change: 'Remember the explicit preference', sourceIndexes: [latest.index], result: { topic: 'Preference', content: latest.message.content, sourceIndexes: [latest.index] } }] }));
    },
  };
}

function assemble(t, { model = modelFixture(), recorder = new Recorder(new RecordBook()), recording = true, failure = 'isolate' } = {}) {
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
  const content = { transcript, memories, view };
  const scene = createMaterialConversationScene();
  const invalidated = [];
  const installation = recording ? createConversationRecording(scene, recorder, { failure, invalidate: (error) => invalidated.push(error) }) : undefined;
  const interactions = createConversationInteractions(model);
  const runner = new Runner(scene, createConversationResources(content, model), interactions, { observations: installation ? [installation] : [] }).build();
  const outputs = [];
  const unsubscribe = runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  t.after(async () => {
    unsubscribe();
    await interactions.settled();
    interactions.close();
  });
  return { content, scene, runner, recorder, installation, interactions, invalidated, outputs, model };
}

const recordsOf = (recorder, kind) => [...recorder.book.values()].filter((record) => record.kind === kind);
const outputOf = (record) => record.value.processes.findLast((process) => process.type === 'return').output;
const relationsTo = (parent, child) => parent.value.relationChanges.filter((relation) => relation.identity.childContextId === child.contextId);

function hasCause(error, expected) {
  const pending = [error];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === expected) return true;
    if (!current || visited.has(current)) continue;
    visited.add(current);
    pending.push(current.cause, ...(current instanceof AggregateError ? current.errors : []));
  }
  return false;
}

test('conversation recording keeps two call trees, real entity origins and reception distinct from returned content', async (t) => {
  const current = assemble(t);
  const firstAnswer = await current.runner.run('Prefer brief answers');
  const firstSnapshot = current.recorder.book.exportState();
  const firstRoot = recordsOf(current.recorder, 'invocation').find((record) => record.structureKind === 'scene');
  const firstRootValue = structuredClone(firstRoot.value);
  const secondAnswer = await current.runner.run('Put the conclusion first');
  const calls = recordsOf(current.recorder, 'invocation');
  const roots = calls.filter((record) => record.structureKind === 'scene');
  assert.equal(roots.length, 2);
  assert.equal(roots[0].structureId, roots[1].structureId);
  assert.notEqual(roots[0].contextId, roots[1].contextId);
  assert.deepEqual(firstRoot.value, firstRootValue, 'a later run must not rewrite completed call facts');
  assert.ok(roots.every((record) => record.parentId === current.installation.root.id && record.role === 'conversation'));
  assert.equal(new Set(calls.map((record) => record.contextId)).size, calls.length);
  assert.ok(
    calls.every((record) => record.status === 'succeeded'),
    'void-returning maintenance must also record a terminal result',
  );
  assert.deepEqual(current.invalidated, []);

  for (const child of calls.filter((record) => record.structureKind !== 'scene')) {
    const parent = current.recorder.book.get(child.parentId);
    assert.ok(parent instanceof CallableRecord);
    assert.ok(parent.childIds.includes(child.id));
    const relations = relationsTo(parent, child);
    assert.deepEqual(
      relations.map(({ change }) => change.kind),
      ['attached', 'returned', 'receiving', 'accepted'],
    );
    assert.ok(relations.every(({ identity }) => identity.parentContextId === parent.contextId));
    assert.ok(relations.slice(1).every(({ childId }) => childId === child.id));
  }

  const expectedAnswers = [firstAnswer, secondAnswer];
  const materialRequests = current.model.requests.filter((request) => request.responseFormat === 'text').map((request) => JSON.parse(request.messages.find((message) => message.role === 'user').content));
  for (const [index, root] of roots.entries()) {
    const answer = calls.find((record) => record.parentId === root.id && record.name === 'answer-from-materials');
    const relations = relationsTo(root, answer);
    const returned = relations.find(({ change }) => change.kind === 'returned').change.result;
    const accepted = relations.find(({ change }) => change.kind === 'accepted').change.output;
    assert.deepEqual(returned, { status: 'succeeded', output: { characters: expectedAnswers[index].length } });
    assert.deepEqual(accepted, { transcriptId: current.content.transcript.id, index: index * 2 + 1, message: { role: 'assistant', content: { characters: expectedAnswers[index].length } } });
    assert.deepEqual(outputOf(root), { characters: expectedAnswers[index].length });
    const transcriptRecords = recordsOf(current.recorder, 'transcript').filter((record) => record.parentId === root.id);
    assert.deepEqual(
      transcriptRecords.map((record) => record.value),
      [
        { action: 'append', start: index * 2, end: index * 2 + 1 },
        { action: 'append', start: index * 2 + 1, end: index * 2 + 2 },
      ],
    );
    assert.ok(transcriptRecords.every((record) => record.callId === root.id && record.contextId === root.contextId && record.transcriptId === current.content.transcript.id));
    const prepared = calls.find((record) => record.parentId === root.id && record.name === 'prepare-conversation-materials');
    assert.deepEqual(outputOf(prepared).materials.basis, materialRequests[index].materials.basis, 'fixed source identities and versions survive summary projection and later content changes');
  }

  const memoryRecords = recordsOf(current.recorder, 'memory');
  assert.deepEqual(
    memoryRecords.map((record) => record.value.action),
    ['create', 'update'],
  );
  assert.equal(memoryRecords[0].memoryId, memoryRecords[1].memoryId);
  for (const record of memoryRecords) {
    const owner = current.recorder.book.get(record.parentId);
    assert.equal(owner.name, 'maintain-conversation-memories');
    assert.equal(owner.value.input.message.role, 'assistant');
    assert.equal(record.callId, owner.id);
    assert.equal(record.contextId, owner.contextId);
    assert.equal(record.memoriesId, current.content.memories.id);
  }
  const send = calls.find((record) => record.name === 'start-completion-request');
  const reference = outputOf(send);
  assert.equal(reference.contract, 'conversation.completion.v1');
  const dispatched = recordsOf(current.recorder, 'resource').find((record) => record.parentId === send.id && record.phase === 'returned' && record.value.action === 'start');
  assert.deepEqual(dispatched.value.output, reference);
  const read = calls.find((record) => record.parentId === send.parentId && record.name === 'read-completion-reply');
  assert.deepEqual(read.value.input, reference, 'send and feedback consumption use the same external interaction');
  assert.deepEqual(
    current.outputs.filter((event) => event.kind === 'delta').map((event) => event.delta),
    [preview, preview],
  );
  assert.ok(!JSON.stringify(current.recorder.book.exportState()).includes(preview), 'preview is not duplicated into the record book');
  assert.ok(!JSON.stringify(calls).includes(firstAnswer), 'call records contain summaries, not repeated formal bodies');
  assert.deepEqual(RecordBook.restore(firstSnapshot).exportState(), firstSnapshot);
});

test('handled proposal failure remains a failed child return while the saved answer succeeds', async (t) => {
  const current = assemble(t, { model: modelFixture({ propose: () => reply('{invalid json') }) });
  const answer = await current.runner.run('Remember this preference');
  const calls = recordsOf(current.recorder, 'invocation');
  const proposal = calls.find((record) => record.name === 'propose-conversation-memories');
  const parent = current.recorder.book.get(proposal.parentId);
  const relations = relationsTo(parent, proposal);
  assert.equal(proposal.status, 'failed');
  assert.equal(parent.status, 'succeeded');
  assert.equal(calls.find((record) => record.structureKind === 'scene').status, 'succeeded');
  assert.deepEqual(
    relations.map(({ change }) => change.kind),
    ['attached', 'returned', 'receiving', 'handled'],
  );
  assert.equal(relations[1].change.result.status, 'failed');
  assert.deepEqual(relations[3].change.output, { status: 'skipped' });
  assert.equal(current.content.transcript.get(1).content, answer);
  assert.equal(recordsOf(current.recorder, 'transcript').length, 2);
  assert.deepEqual(recordsOf(current.recorder, 'memory'), []);
  assert.deepEqual(current.invalidated, []);
});

test('cancellation records the local terminal failure; independent late feedback does not append more call facts', async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  // Register before fixture cleanup so a failed assertion cannot block settled().
  t.after(() => release.resolve());
  const model = modelFixture({
    answer: async (_input, controls) => {
      entered.resolve();
      await release.promise;
      controls.emit?.('LATE_PREVIEW');
      return reply('LATE_FINAL');
    },
  });
  const current = assemble(t, { model });
  const result = current.runner.run('Cancel only the local wait');
  await entered.promise;
  const reason = new Error('stop local consumption');
  assert.equal(current.runner.cancel(reason), true);
  await assert.rejects(result, (error) => hasCause(error, reason));
  assert.equal(current.runner.isRunning, false);
  const calls = recordsOf(current.recorder, 'invocation');
  const root = calls.find((record) => record.structureKind === 'scene');
  assert.equal(root.status, 'failed');
  assert.ok(calls.every((record) => record.status !== 'running'));
  assert.equal(current.content.transcript.length, 1);
  const saved = current.recorder.book.exportState();
  const revision = current.recorder.revision;
  release.resolve();
  await current.interactions.settled();
  assert.equal(current.recorder.revision, revision);
  assert.deepEqual(current.recorder.book.exportState(), saved);
  assert.equal(current.content.transcript.length, 1);
  assert.equal(
    current.outputs.some((event) => event.kind === 'completed'),
    false,
  );
  assert.equal(
    current.outputs.some((event) => event.kind === 'delta' && event.delta === 'LATE_PREVIEW'),
    false,
  );
  assert.equal(model.requests.length, 1);
  assert.deepEqual(current.invalidated, []);
});

test('recording is optional and does not introduce a hidden recorder into ordinary execution', async (t) => {
  const current = assemble(t, { recording: false });
  const result = await current.runner.run('Run with content only');
  assert.equal(current.content.transcript.get(1).content, result);
  assert.equal(current.content.memories.values().length, 1);
  assert.equal(current.recorder.revision, 0);
  assert.deepEqual([...current.recorder.book.values()], []);
});

test('record write failure obeys isolate/propagate without undoing or repeating earlier content commits', async (t) => {
  for (const failure of ['isolate', 'propagate']) {
    await t.test(failure, async (t) => {
      const cause = new Error('record storage unavailable after assistant append');
      let rejected = 0;
      class RejectingRecorder extends Recorder {
        add(record) {
          if (record.kind === 'transcript' && record.value.start === 1) {
            rejected++;
            throw cause;
          }
          return super.add(record);
        }
      }
      const current = assemble(t, { recorder: new RejectingRecorder(new RecordBook()), failure });
      if (failure === 'isolate') assert.equal(await current.runner.run('Keep accepted facts'), 'Formal answer: Keep accepted facts');
      else await assert.rejects(current.runner.run('Keep accepted facts'), (error) => hasCause(error, cause));
      assert.equal(current.content.transcript.length, 2, 'formal append remains true even when its observation fails');
      assert.equal(current.content.transcript.get(1).content, 'Formal answer: Keep accepted facts');
      assert.equal(current.model.requests.filter((request) => request.responseFormat === 'text').length, 1);
      assert.equal(rejected, 1);
      assert.ok(current.invalidated.some((error) => hasCause(error, cause)));
      assert.equal(current.runner.isRunning, false);
      const root = recordsOf(current.recorder, 'invocation').find((record) => record.structureKind === 'scene');
      assert.equal(root.status, 'running', 'incomplete observation must not invent a terminal record');
      assert.equal(current.content.memories.values().length, failure === 'isolate' ? 1 : 0);
    });
  }
});

test('service descriptions preserve execution identity without evaluating accessors or copying unusual values', async () => {
  let getters = 0;
  const result = { absent: undefined, finite: 42, infinite: Infinity, nan: NaN, big: 1n, array: Array.from({ length: 100 }, () => 'PRIVATE_ARRAY_CONTENT') };
  Object.defineProperty(result, 'derived', {
    enumerable: true,
    get() {
      getters++;
      throw new Error('not a recording operation');
    },
  });
  const node = new Node({ run: () => result });
  const scene = new Scene(node);
  const recorder = new Recorder(new RecordBook());
  const invalidated = [];
  const installation = createConversationRecording(scene, recorder, { invalidate: (error) => invalidated.push(error) });
  const runner = new Runner(scene, new Resources(), undefined, { observations: [installation] }).build();
  assert.equal(await runner.run(null), result);
  assert.equal(getters, 0);
  assert.deepEqual(invalidated, []);
  for (const record of recordsOf(recorder, 'invocation')) {
    assert.equal(record.status, 'succeeded');
    assert.deepEqual(outputOf(record), { absent: { type: 'undefined' }, finite: 42, infinite: { type: 'number', value: 'Infinity' }, nan: { type: 'number', value: 'NaN' }, big: { type: 'bigint' }, array: { items: 100 }, derived: { type: 'accessor' } });
  }
  assert.ok(!JSON.stringify(recorder.book.exportState()).includes('PRIVATE_ARRAY_CONTENT'));
});
