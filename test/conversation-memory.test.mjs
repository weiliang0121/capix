import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChangeCaptureError } from '@capix/changes';
import { CompletionResource, ConversationMemoryResource, ConversationViewResource, createConversationScene, createMaterialPreparation, createMemoryMaintenance, createMessageInclusion } from '@capix/conversation-service';
import { PersistenceError } from '@capix/diagnostics';
import { Memories, MemoryResource, MemoryViewSource } from '@capix/memory';
import { Resource, Resources as ResourceRegistry } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Group, Node } from '@capix/structure';
import { Transcript, TranscriptResource, TranscriptViewSource } from '@capix/transcript';
import { View } from '@capix/view';

const messageRef = (key) => ({ source: 'messages', key });
const memoryRef = (key) => ({ source: 'memories', key });
const reply = (text) => ({ id: 'offline-memory', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });
const create = (content = 'Prefer short Chinese answers', indexes = [0]) => ({ action: 'create', memoryId: null, change: 'Preserve the stated preference', sourceIndexes: indexes, result: { topic: 'Answer preference', content, sourceIndexes: indexes } });
const update = (memory, content = memory.content, indexes = memory.sourceIndexes) => ({ ...create(content, indexes), action: 'update', memoryId: memory.id, result: { topic: memory.topic, content, sourceIndexes: indexes } });

function fixture({ messages = [], memoryOptions, persistence } = {}) {
  const transcript = new Transcript(messages);
  const memories = new Memories(transcript, memoryOptions);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
  return { transcript, memories, view, persistence };
}

function sources(content) {
  return { messages: new TranscriptViewSource(content.transcript), memories: new MemoryViewSource(content.memories) };
}

function model(propose) {
  const inputs = [];
  return {
    inputs,
    async complete(request, controls) {
      assert.equal(request.responseFormat, 'json_object');
      const input = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      inputs.push(input);
      const changes = await propose(input, inputs.length, controls);
      return reply(JSON.stringify({ changes }));
    },
  };
}

function resources(content, provider, { capture = content.memories, writer = content.memories, management = content } = {}) {
  return new Resources().register(new Resource(content.transcript), TranscriptResource.append).register(new Resource(content), ConversationViewResource.read).register(new Resource(management), ConversationViewResource.manage).register(new Resource(capture), ConversationMemoryResource).register(new Resource(writer), MemoryResource.apply).register(new Resource(provider), CompletionResource);
}

function assemble(content, provider, { inclusion = true, ...wiring } = {}) {
  const inputs = [];
  const outputs = [];
  const observations = [];
  const answer = new Node({ run: (work) => (inputs.push(work.input), `answer ${inputs.length}`) });
  let maintain = createMemoryMaintenance();
  if (inclusion) {
    maintain = new Group().add({ include: createMessageInclusion(), remember: maintain });
    maintain.run = async (work) => {
      await work.children.include.invoke(work.input);
      await work.children.remember.invoke(work.input);
    };
  }
  const runner = new Runner(createConversationScene(answer, createMaterialPreparation(), maintain), resources(content, provider, wiring)).build();
  runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  runner.observation.subscribe({ receive: (event) => void observations.push(event) });
  return { runner, inputs, outputs, observations };
}

function childRelations(observations, name) {
  const childId = observations.findLast((event) => event.source === 'invocation' && event.fact.kind === 'started' && event.fact.description?.name === name)?.fact.identity.contextId;
  assert.ok(childId, `Missing observed call: ${name}`);
  return observations.filter((event) => event.source === 'invocation' && event.fact.kind === 'relation' && event.fact.relation.childContextId === childId).map(({ fact }) => fact);
}

test('formal memory creation enters the View by its real ID and is fixed material for the next submission', async () => {
  const memoryCommits = [];
  const viewCommits = [];
  const content = fixture({ memoryOptions: { persistence: { commit: (change) => void memoryCommits.push(change) } }, persistence: { commit: (change) => void viewCommits.push(change) } });
  const provider = model((_input, call) => (call === 1 ? [create()] : []));
  const { runner, inputs } = assemble(content, provider);

  assert.equal(await runner.run('Please use short Chinese answers'), 'answer 1');
  const [memory] = content.memories.values();
  assert.ok(memory.id);
  assert.deepEqual(content.view.members(), [messageRef(0), messageRef(1), memoryRef(memory.id)]);
  assert.equal(memoryCommits.length, 1);
  assert.deepEqual(
    memoryCommits[0].upserts.map(({ id }) => id),
    [memory.id],
  );
  assert.deepEqual(viewCommits.at(-1).state.members.at(-1), memoryRef(memory.id));
  assert.equal(await runner.run('What did I ask for?'), 'answer 2');
  assert.equal(provider.inputs.length, 2, 'only assistant maintenance calls the model');
  assert.deepEqual(
    provider.inputs.map((input) => input.acceptedIndex),
    [1, 3],
  );
  assert.deepEqual(provider.inputs[0].messages, [
    { index: 0, message: { role: 'user', content: 'Please use short Chinese answers' } },
    { index: 1, message: { role: 'assistant', content: 'answer 1' } },
  ]);
  assert.deepEqual(provider.inputs[0].basis, { transcriptId: content.transcript.id, memoriesId: content.memories.id, sequence: 0 });
  assert.deepEqual(provider.inputs[1].memories, [memory.toJSON()]);
  const entry = inputs[1].materials.entries.find((entry) => entry.source === 'memories');
  assert.deepEqual(entry, { ...memoryRef(memory.id), value: memory.toJSON() });
  assert.equal(inputs[1].materials.basis.sources.memories.id, content.memories.id);
  assert.deepEqual(inputs[0].materials.entries, [], 'later membership does not alter prior answer material');
  assert.equal(content.memories.sequence, 1, 'empty proposals do not write another memory');
});

test('updates may replace old message sources while retaining identity and active membership', async () => {
  const content = fixture();
  const provider = model((input, call) => (call === 1 ? [create()] : [update(input.memories[0], 'Prefer concise Chinese answers', [2])]));
  const { runner, inputs } = assemble(content, provider);
  await runner.run('Please use short Chinese answers');
  const [memory] = content.memories.values();
  const originalMessage = content.transcript.get(0);
  await runner.run('Keep it concise');
  assert.equal(content.memories.values().length, 1);
  assert.equal(content.memories.get(memory.id), memory);
  assert.equal(memory.content, 'Prefer concise Chinese answers');
  assert.deepEqual(memory.sourceIndexes, [2]);
  assert.equal(content.memories.sequence, 2);
  assert.equal(content.view.members().filter((entry) => entry.source === 'memories').length, 1);
  assert.equal(content.view.has(memoryRef(memory.id)), true);
  assert.equal(content.transcript.get(0), originalMessage, 'removing a memory source does not alter the source message');
  assert.deepEqual(content.transcript.snapshot(), [
    { role: 'user', content: 'Please use short Chinese answers' },
    { role: 'assistant', content: 'answer 1' },
    { role: 'user', content: 'Keep it concise' },
    { role: 'assistant', content: 'answer 2' },
  ]);
  assert.deepEqual(provider.inputs[1].memories[0].sourceIndexes, [0], 'the proposal used the previous fixed memory');
  assert.equal(inputs[1].materials.entries.find((entry) => entry.source === 'memories').value.content, 'Prefer short Chinese answers', 'the earlier capture remains unchanged after memory update');
  assert.deepEqual(inputs[1].materials.entries.find((entry) => entry.source === 'memories').value.sourceIndexes, [0]);
  const revision = content.view.exportState().revision;
  await runner.run('Continue');
  assert.deepEqual(inputs[2].materials.entries.find((entry) => entry.source === 'memories').value.sourceIndexes, [2]);
  assert.equal(content.memories.sequence, 2, 'the same formal update is a no-op');
  assert.equal(content.view.exportState().revision, revision + 2, 'only new messages change membership');
});

test('replacing an inactive memory source does not reinclude it; an explicit View operation may do so', async () => {
  const content = fixture();
  const provider = model((input, call) => (call === 1 ? [create()] : [update(input.memories[0], 'Prefer concise Chinese answers', [2])]));
  const { runner, inputs } = assemble(content, provider);
  await runner.run('Please use short Chinese answers');
  const [memory] = content.memories.values();
  content.view.excludeSync([memoryRef(memory.id)]);
  await runner.run('Keep it concise');
  assert.equal(provider.inputs[1].memories[0].id, memory.id, 'maintenance sees the entity even when answer material excludes it');
  assert.deepEqual(provider.inputs[1].memories[0].sourceIndexes, [0], 'the captured old sources do not drift after updating');
  assert.equal(content.memories.get(memory.id), memory);
  assert.equal(content.memories.get(memory.id).content, 'Prefer concise Chinese answers');
  assert.deepEqual(memory.sourceIndexes, [2]);
  assert.equal(content.transcript.get(0).content, 'Please use short Chinese answers');
  assert.equal(content.transcript.get(2).content, 'Keep it concise');
  assert.equal(content.view.has(memoryRef(memory.id)), false);
  assert.ok(inputs[1].materials.entries.every((entry) => entry.source !== 'memories'));
  content.view.includeSync(sources(content), [memoryRef(memory.id)]);
  await runner.run('Continue');
  assert.equal(inputs[2].materials.entries.find((entry) => entry.source === 'memories').value.content, 'Prefer concise Chinese answers');
});

test('memory maintenance is independently composed and does not implicitly include messages', async () => {
  const content = fixture();
  const provider = model((_input, call) => (call === 1 ? [create()] : []));
  const { runner, inputs } = assemble(content, provider, { inclusion: false });
  await runner.run('Remember my preference');
  const [memory] = content.memories.values();
  assert.deepEqual(content.view.members(), [memoryRef(memory.id)]);
  await runner.run('Continue');
  assert.deepEqual(
    inputs[1].materials.entries.map(({ source }) => source),
    ['memories'],
  );
});

test('candidate field, source and target violations skip the whole batch while delivering the saved answer', async (t) => {
  const cases = {
    'create chooses an ID': (context) => [{ ...create(), memoryId: context.memories[0].id }],
    'unknown update target': () => [{ ...create(), action: 'update', memoryId: 'unknown' }],
    'duplicate update target': (context) => [update(context.memories[0], 'one'), update(context.memories[0], 'two')],
    'future evidence': () => [create('invented', [200])],
    'fractional evidence': () => [create('invented', [0.5])],
    'duplicate evidence': () => [create('invented', [0, 0])],
    'empty change evidence': () => [{ ...create(), sourceIndexes: [] }],
    'empty result evidence': () => [{ ...create(), result: { ...create().result, sourceIndexes: [] } }],
    'missing evidence in result': () => [{ ...create('invented', [0]), result: { topic: 'topic', content: 'invented', sourceIndexes: [1] } }],
    'forged receipt': () => [{ ...create(), sourceResults: [] }],
    'forged result receipt': () => [{ ...create(), result: { ...create().result, sourceResults: [] } }],
    'extra field': () => [{ ...create(), urgency: 'high' }],
    'blank content': () => [create('  ')],
    'too many changes': () => Array.from({ length: 33 }, () => create()),
  };
  for (const [name, invalid] of Object.entries(cases)) {
    await t.test(name, async () => {
      const commits = [];
      const content = fixture({
        messages: [
          { role: 'user', content: 'old preference' },
          { role: 'assistant', content: 'accepted' },
        ],
        memoryOptions: { persistence: { commit: (change) => void commits.push(change) } },
      });
      content.memories.apply([create('old preference')]);
      const before = content.memories.exportState();
      const provider = model((input) => [create('otherwise valid'), ...invalid(input)]);
      const { runner } = assemble(content, provider, { inclusion: false });
      assert.equal(await runner.run('new message'), 'answer 1');
      assert.deepEqual(content.memories.exportState(), before);
      assert.equal(commits.length, 1, 'only the fixture write was committed');
      assert.deepEqual(content.view.members(), []);
      assert.equal(content.transcript.get(3).content, 'answer 1', 'the formal answer is retained');
      assert.equal(provider.inputs.length, 1, 'invalid output is not regenerated');
      assert.equal(runner.isRunning, false);
    });
  }
});

test('an update inherits existing formal operation evidence without asking the model to reproduce receipts', async () => {
  const content = fixture({
    messages: [
      { role: 'user', content: 'Save this file' },
      { role: 'assistant', content: 'File saved' },
    ],
  });
  const receipt = { id: 'file-result', kind: 'file-created', answerIndex: 1, receipt: { path: 'notes.md', bytes: 12, digest: 'a'.repeat(64) } };
  const change = create('Saved notes.md', [0, 1]);
  change.result.sourceResults = [receipt];
  const [memory] = content.memories.apply([change]);
  const provider = model((input) => [update(input.memories[0], 'Saved notes.md; retain for later', [0, 1, 2])]);
  const { runner } = assemble(content, provider);
  await runner.run('Keep this for later');
  assert.deepEqual(memory.sourceResults, [receipt]);
  assert.deepEqual(memory.sourceIndexes, [0, 1, 2]);
  assert.equal(content.memories.values().length, 1);
  assert.equal(content.view.has(memoryRef(memory.id)), false, 'an existing inactive memory remains inactive');
});

test('model and completion failures are handled as skipped proposals without memory or View writes', async (t) => {
  for (const kind of ['rejection', 'length', 'empty', 'invalid JSON', 'extra proposal field']) {
    await t.test(kind, async () => {
      const content = fixture();
      let calls = 0;
      const provider = {
        async complete() {
          calls++;
          if (kind === 'rejection') throw new Error('model unavailable');
          if (kind === 'length') return { ...reply('{"changes":[]}'), termination: { kind: 'incomplete', reason: 'length' } };
          if (kind === 'empty') return reply('');
          if (kind === 'invalid JSON') return reply('not json');
          return reply('{"changes":[],"note":"extra"}');
        },
      };
      const { runner, outputs, observations } = assemble(content, provider, { inclusion: false });
      assert.equal(await runner.run('question'), 'answer 1');
      assert.deepEqual(content.transcript.snapshot(), [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer 1' },
      ]);
      assert.deepEqual(content.memories.snapshot(), []);
      assert.deepEqual(content.view.members(), []);
      assert.equal(
        outputs.some((event) => event.kind === 'completed'),
        true,
      );
      const relation = childRelations(observations, 'propose-conversation-memories');
      assert.equal(relation.find((fact) => fact.phase === 'returned')?.status, 'failed');
      assert.equal(
        relation.some((fact) => fact.phase === 'handled'),
        true,
        'the preset receives the failed proposal',
      );
      assert.equal(
        relation.some((fact) => fact.phase === 'accepted'),
        false,
        'a skipped proposal is not an accepted empty proposal',
      );
      assert.equal(calls, 1);
    });
  }
});

test('the Scene waits for pending extraction before a handled failure releases the saved answer', async () => {
  const content = fixture();
  const { promise: started, resolve: markStarted } = Promise.withResolvers();
  const { promise: pending, reject: failProposal } = Promise.withResolvers();
  const provider = model(() => {
    markStarted();
    return pending;
  });
  const { runner, outputs } = assemble(content, provider, { inclusion: false });
  let settled = false;
  const running = runner.run('Remember this').then((answer) => {
    settled = true;
    return answer;
  });
  await started;
  assert.equal(content.transcript.get(1).content, 'answer 1', 'the answer already exists while extraction is pending');
  assert.equal(settled, false);
  assert.equal(runner.isRunning, true);
  assert.equal(
    outputs.some((event) => event.kind === 'completed'),
    false,
  );

  failProposal(new Error('extraction unavailable'));
  assert.equal(await running, 'answer 1');
  assert.equal(settled, true);
  assert.equal(runner.isRunning, false);
  assert.equal(outputs.filter((event) => event.kind === 'completed').length, 1);
  assert.deepEqual(content.memories.snapshot(), []);
  assert.deepEqual(content.view.members(), []);
  assert.equal(provider.inputs.length, 1, 'finishing the skipped branch does not retry extraction');
});

test('a skipped proposal bypasses writes while a successful empty proposal still checks the captured basis', async (t) => {
  for (const skipped of [true, false]) {
    await t.test(skipped ? 'failed proposal' : 'successful empty proposal', async () => {
      let commits = 0;
      const content = fixture({ memoryOptions: { persistence: { commit: () => void commits++ } } });
      const provider = model(() => {
        content.memories.apply([create('concurrent formal memory')]);
        if (skipped) throw new Error('no proposal available');
        return [];
      });
      const { runner, outputs, observations } = assemble(content, provider, { inclusion: false });
      if (skipped) assert.equal(await runner.run('question'), 'answer 1');
      else await assert.rejects(runner.run('question'), { code: 'MEMORY_BASIS_CONFLICT' });

      assert.equal(commits, 1, 'only the concurrent change is written');
      assert.equal(content.memories.sequence, 1);
      assert.equal(content.memories.values()[0].content, 'concurrent formal memory');
      assert.deepEqual(content.view.members(), []);
      assert.equal(content.transcript.get(1).content, 'answer 1');
      assert.equal(
        outputs.some((event) => event.kind === 'completed'),
        skipped,
      );
      const relation = childRelations(observations, 'propose-conversation-memories');
      assert.equal(relation.find((fact) => fact.phase === 'returned')?.status, skipped ? 'failed' : 'succeeded');
      assert.equal(
        relation.some((fact) => fact.phase === 'handled'),
        skipped,
      );
      assert.equal(
        relation.some((fact) => fact.phase === 'accepted'),
        !skipped,
      );
      assert.equal(provider.inputs.length, 1);
    });
  }
});

test('protected failures inside the proposal cannot become a skipped extraction', async (t) => {
  const cause = new Error('required model feedback processing failed');
  const failures = [new PersistenceError('model.feedback', cause), new ChangeCaptureError({ kind: 'model-feedback' }, cause)];
  for (const failure of failures) {
    await t.test(failure.constructor.name, async () => {
      const content = fixture();
      const provider = model(() => {
        throw failure;
      });
      const { runner, outputs, observations } = assemble(content, provider, { inclusion: false });
      await assert.rejects(runner.run('question'), (error) => error === failure);
      assert.equal(content.transcript.get(1).content, 'answer 1');
      assert.deepEqual(content.memories.snapshot(), []);
      assert.deepEqual(content.view.members(), []);
      assert.equal(
        outputs.some((event) => event.kind === 'completed'),
        false,
      );
      const relation = childRelations(observations, 'propose-conversation-memories');
      assert.equal(relation.find((fact) => fact.phase === 'returned')?.status, 'failed');
      assert.equal(
        relation.some((fact) => fact.phase === 'handled'),
        false,
      );
      assert.equal(provider.inputs.length, 1);
      assert.equal(runner.isRunning, false);
    });
  }
});

test('memory persistence failure leaves the formal answer intact and never attempts View inclusion', async () => {
  let memoryCommits = 0;
  let viewCommits = 0;
  const content = fixture({
    memoryOptions: {
      persistence: {
        commit() {
          memoryCommits++;
          throw new Error('memory store unavailable');
        },
      },
    },
    persistence: {
      commit() {
        viewCommits++;
      },
    },
  });
  const provider = model(() => [create()]);
  const { runner } = assemble(content, provider, { inclusion: false });
  await assert.rejects(runner.run('Remember this'));
  assert.equal(memoryCommits, 1);
  assert.equal(viewCommits, 0);
  assert.equal(content.memories.sequence, 0);
  assert.deepEqual(content.memories.snapshot(), []);
  assert.equal(content.transcript.get(1).content, 'answer 1');
});

test('a concurrent entity update while the model is pending rejects the captured basis instead of overwriting it', async () => {
  const content = fixture({
    messages: [
      { role: 'user', content: 'old preference' },
      { role: 'assistant', content: 'noted' },
    ],
  });
  const [memory] = content.memories.apply([create('old preference')]);
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  let resume;
  const delayed = new Promise((resolve) => {
    resume = resolve;
  });
  const provider = model(async (input) => {
    started();
    await delayed;
    return [update(input.memories[0], 'stale proposed preference', [0, 2])];
  });
  const { runner } = assemble(content, provider, { inclusion: false });
  const result = runner.run('new preference');
  const rejected = assert.rejects(result);
  await waiting;
  content.memories.apply([update(memory, 'concurrent accepted preference')]);
  resume();
  await rejected;
  assert.equal(memory.content, 'concurrent accepted preference');
  assert.equal(content.memories.sequence, 2);
  assert.deepEqual(content.view.members(), []);
  assert.equal(provider.inputs[0].memories[0].content, 'old preference');
  assert.equal(provider.inputs.length, 1);
});

test('View commit failure preserves an applied memory; later maintenance sees it but does not retry inclusion or duplicate creation', async () => {
  let viewCommits = 0;
  const content = fixture({
    persistence: {
      commit() {
        viewCommits++;
        throw new Error('View store unavailable');
      },
    },
  });
  const provider = model((input) => (input.memories.length ? [] : [create()]));
  const { runner, inputs } = assemble(content, provider, { inclusion: false });
  await assert.rejects(runner.run('Remember this'));
  const [memory] = content.memories.values();
  assert.ok(memory);
  assert.equal(content.memories.sequence, 1);
  assert.deepEqual(content.view.members(), []);
  assert.equal(viewCommits, 1);
  assert.equal(await runner.run('Continue'), 'answer 2');
  assert.equal(provider.inputs[1].memories[0].id, memory.id);
  assert.deepEqual(inputs[1].materials.entries, [], 'the answer reads actual View membership');
  assert.equal(content.memories.values().length, 1);
  assert.equal(viewCommits, 1, 'no background repair or re-inclusion is implied');
});

test('memory publication failure may follow a committed write and must not be mistaken for a rollback', async () => {
  const content = fixture({
    memoryOptions: {
      changes: {
        capture() {
          throw new Error('change consumption failed');
        },
      },
    },
  });
  const provider = model((input) => (input.memories.length ? [] : [create()]));
  const { runner } = assemble(content, provider, { inclusion: false });
  await assert.rejects(runner.run('Remember this'));
  const [memory] = content.memories.values();
  assert.ok(memory);
  assert.equal(content.memories.sequence, 1);
  assert.deepEqual(content.view.members(), []);
  assert.equal(await runner.run('Continue'), 'answer 2');
  assert.equal(content.memories.values().length, 1);
  assert.equal(provider.inputs[1].memories[0].id, memory.id);
});

test('miswired memory capture, writer or View is rejected before changing either memory collection', async (t) => {
  for (const kind of ['capture', 'writer', 'view']) {
    await t.test(kind, async () => {
      const content = fixture();
      const foreign = kind === 'capture' ? fixture() : { ...content, memories: new Memories(content.transcript) };
      if (kind === 'view') foreign.view = new View({ revision: 0, sources: { messages: { id: content.transcript.id, scope: 'whole' }, memories: { id: foreign.memories.id, scope: 'whole' } }, members: [] });
      const provider = model(() => [create()]);
      const wiring = kind === 'capture' ? { capture: foreign.memories } : kind === 'writer' ? { writer: foreign.memories } : { management: foreign };
      const { runner } = assemble(content, provider, { inclusion: false, ...wiring });
      await assert.rejects(runner.run('question'));
      assert.deepEqual(content.memories.snapshot(), []);
      assert.deepEqual(foreign.memories.snapshot(), []);
      assert.deepEqual(content.view.members(), []);
      assert.equal(provider.inputs.length, kind === 'writer' ? 1 : 0);
      assert.equal(content.transcript.get(1).content, 'answer 1');
    });
  }
});

test('context capture verifies the formal message and returns immutable content independent of later entity updates', async () => {
  const content = fixture({
    messages: [
      { role: 'user', content: 'preference' },
      { role: 'assistant', content: 'noted' },
    ],
  });
  const [memory] = content.memories.apply([create('preference')]);
  const access = new ResourceRegistry().register(new Resource(content.memories), ConversationMemoryResource).bind({ context: ConversationMemoryResource.request() }).open();
  const accepted = { transcriptId: content.transcript.id, index: 1, message: content.transcript.get(1) };
  try {
    const context = await access.endpoints.context.capture(accepted);
    assert.ok(Object.isFrozen(context));
    assert.ok(Object.isFrozen(context.basis));
    assert.ok(Object.isFrozen(context.messages));
    assert.ok(Object.isFrozen(context.memories[0]));
    content.memories.apply([update(memory, 'later preference')]);
    assert.equal(context.memories[0].content, 'preference');
    await assert.rejects(access.endpoints.context.capture({ ...accepted, message: { role: 'assistant', content: 'forged text' } }));
    await assert.rejects(access.endpoints.context.capture({ ...accepted, transcriptId: 'foreign' }));
  } finally {
    access.close();
  }
});

test('cancelling model maintenance retains the formal answer without writing memory or completed output', async () => {
  const content = fixture();
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const provider = model(
    (_input, _call, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      }),
  );
  const { runner, outputs } = assemble(content, provider, { inclusion: false });
  const result = runner.run('Remember this');
  const rejected = assert.rejects(result);
  await waiting;
  assert.equal(runner.cancel(new Error('stop local maintenance')), true);
  await rejected;
  assert.equal(content.transcript.get(1).content, 'answer 1');
  assert.deepEqual(content.memories.snapshot(), []);
  assert.deepEqual(content.view.members(), []);
  assert.equal(
    outputs.some((event) => event.kind === 'completed'),
    false,
  );
  assert.equal(runner.isRunning, false);
});

test('proposal skips stay inside maintenance while a broader decision only receives later operation exceptions', async (t) => {
  for (const kind of ['model failure', 'candidate rejection', 'basis conflict', 'memory commit', 'View commit', 'change capture']) {
    await t.test(kind, async () => {
      const failure = new Error(`${kind} unavailable`);
      const content = fixture({
        ...(kind === 'memory commit'
          ? {
              memoryOptions: {
                persistence: {
                  commit() {
                    throw failure;
                  },
                },
              },
            }
          : {}),
        ...(kind === 'change capture'
          ? {
              memoryOptions: {
                changes: {
                  capture() {
                    throw failure;
                  },
                },
              },
            }
          : {}),
        ...(kind === 'View commit'
          ? {
              persistence: {
                commit() {
                  throw failure;
                },
              },
            }
          : {}),
      });
      const provider = model(() => {
        if (kind === 'model failure') throw failure;
        if (kind === 'candidate rejection') return [{ ...create(), memoryId: 'invented-identity' }];
        if (kind === 'basis conflict') content.memories.apply([create('concurrent formal memory')]);
        return [create('proposed memory')];
      });
      const decisions = [];
      const facts = [];
      const observations = [];
      const outputs = [];
      const remember = createMemoryMaintenance();
      const decide = new Node({
        name: 'decide-maintenance-failure',
        run: (work) => {
          decisions.push(work.input);
        },
      });
      const maintain = new Group({ name: 'maintenance-with-explicit-decision' }).add({ remember, decide });
      maintain.run = async (work) => {
        await work.children.remember.invoke(work.input, {
          result: { failed: (error) => work.children.decide.invoke(error) },
        });
        facts.push(...work.children.facts.list(remember));
      };
      const answer = new Node({ run: () => 'formally saved answer' });
      const runner = new Runner(createConversationScene(answer, createMaterialPreparation(), maintain), resources(content, provider)).build();
      runner.observation.subscribe({ receive: (event) => void observations.push(event) });
      runner.output.subscribe({ receive: (event) => void outputs.push(event) });
      const skipped = ['model failure', 'candidate rejection'].includes(kind);
      const handled = kind === 'basis conflict';
      const succeeds = skipped || handled;

      if (succeeds) assert.equal(await runner.run('Please remember this'), 'formally saved answer');
      else await assert.rejects(runner.run('Please remember this'));

      assert.deepEqual(content.transcript.snapshot(), [
        { role: 'user', content: 'Please remember this' },
        { role: 'assistant', content: 'formally saved answer' },
      ]);
      assert.equal(provider.inputs.length, 1, 'the explicit decision does not regenerate or retry maintenance');
      assert.equal(decisions.length, handled ? 1 : 0);
      assert.equal(
        outputs.some((event) => event.kind === 'completed'),
        succeeds,
      );
      assert.equal(runner.isRunning, false);
      const relation = childRelations(observations, 'maintain-conversation-memories');
      assert.equal(relation.find((fact) => fact.phase === 'returned')?.status, skipped ? 'succeeded' : 'failed');
      assert.equal(
        relation.some((fact) => fact.phase === 'handled'),
        handled,
        'handling preserves the original failed return',
      );
      assert.equal(
        relation.some((fact) => fact.phase === 'accepted'),
        skipped,
      );
      if (handled) {
        const fact = facts.find((fact) => fact.returned?.status === 'failed');
        assert.ok(fact);
        assert.equal(fact.returned.failure.kind, 'error', 'diagnostic kind alone does not determine reception eligibility');
        assert.equal(fact.reception.status, 'handled');
        assert.equal(fact.reception.value, undefined);
        assert.equal(decisions[0].code, 'MEMORY_BASIS_CONFLICT');
      }
      if (skipped) {
        const proposal = childRelations(observations, 'propose-conversation-memories');
        assert.equal(proposal.find((fact) => fact.phase === 'returned')?.status, 'failed');
        assert.equal(
          proposal.some((fact) => fact.phase === 'handled'),
          true,
        );
        assert.equal(
          proposal.some((fact) => fact.phase === 'accepted'),
          false,
        );
      }
      assert.deepEqual(content.view.members(), []);
      const applied = ['basis conflict', 'View commit', 'change capture'].includes(kind);
      assert.equal(content.memories.sequence, applied ? 1 : 0);
      if (applied) assert.equal(content.memories.values()[0].content, kind === 'basis conflict' ? 'concurrent formal memory' : 'proposed memory');
    });
  }
});
