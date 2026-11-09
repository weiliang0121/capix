import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { ConversationViewResource, createConversationScene, createMaterialPreparation, createMessageInclusion, HistoryResource } from '@capix/conversation-service';
import { Memories } from '@weiliang0121/capix-memory';
import { Resource, Resources as ResourceRegistry } from '@weiliang0121/capix-resources';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { Group, Node, Scene } from '@weiliang0121/capix-structure';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';
import { View } from '@weiliang0121/capix-view';

const messageRef = (key) => ({ source: 'messages', key });
const collect = (events) => ({ receive: (event) => void events.push(event) });

function fixture(transcript = new Transcript(), members = []) {
  const memories = new Memories(transcript);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members });
  return { transcript, memories, view };
}

function assemble(content, answer, maintain, prepare = createMaterialPreparation()) {
  const messages = new Resource(content.transcript);
  const material = new Resource(content);
  const resources = new Resources().register(messages, TranscriptResource.append).register(messages, HistoryResource).register(material, ConversationViewResource.read).register(material, ConversationViewResource.manage);
  return new Runner(createConversationScene(answer, prepare, maintain), resources).build();
}

function managerAccess(content) {
  return new ResourceRegistry().register(new Resource(content), ConversationViewResource.manage).bind({ view: ConversationViewResource.manage.request() }).open();
}

test('optional inclusion makes prior formal messages available on the next submission while excluding the current query', async () => {
  const content = fixture();
  const commits = [];
  content.persistence = { commit: (change) => void commits.push(change) };
  const inputs = [];
  const answer = new Node({ run: (work) => (inputs.push(work.input), `answer ${inputs.length}`) });
  const runner = assemble(content, answer, createMessageInclusion());

  assert.equal(await runner.run('first'), 'answer 1');
  assert.equal(await runner.run('second'), 'answer 2');
  assert.deepEqual(inputs[0].materials.entries, []);
  assert.deepEqual(
    inputs[1].materials.entries.map(({ source, key, value }) => ({ source, key, value })),
    [
      { ...messageRef(0), value: { role: 'user', content: 'first' } },
      { ...messageRef(1), value: { role: 'assistant', content: 'answer 1' } },
    ],
  );
  assert.deepEqual(
    inputs.map((input) => input.query),
    [
      { transcriptId: content.transcript.id, index: 0, content: 'first' },
      { transcriptId: content.transcript.id, index: 2, content: 'second' },
    ],
  );
  assert.deepEqual(content.view.members(), [0, 1, 2, 3].map(messageRef));
  assert.deepEqual(
    commits.map(({ previous, state, checkedSources }) => [previous.revision, state.revision, Object.keys(checkedSources)]),
    [
      [0, 1, ['messages']],
      [1, 2, ['messages']],
      [2, 3, ['messages']],
      [3, 4, ['messages']],
    ],
  );
  assert.equal(inputs[0].materials.basis.viewRevision, 1);
  assert.equal(inputs[1].materials.basis.viewRevision, 3);
  assert.deepEqual(inputs[0].materials.entries, [], 'a later inclusion does not rewrite an earlier capture');
});

test('registering management alone does not install a maintenance policy or change membership', async () => {
  const content = fixture();
  const before = content.view.exportState();
  const inputs = [];
  const observations = [];
  const answer = new Node({ run: (work) => (inputs.push(work.input), 'answer') });
  const runner = assemble(content, answer);
  runner.observation.subscribe(collect(observations));

  await runner.run('first');
  await runner.run('second');
  assert.equal(content.transcript.length, 4);
  assert.equal(content.view.exportState(), before);
  assert.ok(inputs.every((input) => input.materials.entries.length === 0));
  assert.equal(observations.filter((event) => event.source === 'invocation' && event.fact.kind === 'started').length, 6, 'each run creates only the Scene, preparation and answer');
});

test('independent conversations include their real append positions without backfilling history or sharing membership', async () => {
  const first = fixture(
    new Transcript([
      { role: 'user', content: 'old first' },
      { role: 'assistant', content: 'old answer' },
    ]),
  );
  const second = fixture(new Transcript([{ role: 'user', content: 'old second' }]));
  const inputs = [];
  const makeRunner = (content) => assemble(content, new Node({ run: (work) => (inputs.push(work.input), 'same answer') }), createMessageInclusion());
  const firstRunner = makeRunner(first);
  const secondRunner = makeRunner(second);

  await firstRunner.run('same question');
  await secondRunner.run('same question');
  await firstRunner.run('follow up');
  assert.notEqual(first.transcript.id, second.transcript.id);
  assert.deepEqual(
    inputs.map(({ query }) => [query.transcriptId, query.index]),
    [
      [first.transcript.id, 2],
      [second.transcript.id, 1],
      [first.transcript.id, 4],
    ],
  );
  assert.deepEqual(
    inputs[2].materials.entries.map(({ key }) => key),
    [2, 3],
  );
  assert.deepEqual(first.view.members(), [2, 3, 4, 5].map(messageRef));
  assert.deepEqual(second.view.members(), [1, 2].map(messageRef));
  assert.equal(inputs[1].materials.basis.sources.memories.id, second.memories.id);
});

test('inclusion rejects foreign accepted messages and nonexistent positions before changing membership', async (t) => {
  for (const invalid of ['foreign transcript', 'missing key', 'negative key', 'fractional key']) {
    await t.test(invalid, async () => {
      const content = fixture(new Transcript([{ role: 'user', content: 'same text' }]));
      let commits = 0;
      content.persistence = { commit: () => void commits++ };
      const resources = new Resources().register(new Resource(content), ConversationViewResource.manage);
      const runner = new Runner(new Scene(createMessageInclusion()), resources).build();
      const index = invalid === 'missing key' ? 4 : invalid === 'negative key' ? -1 : invalid === 'fractional key' ? 0.5 : 0;
      const transcriptId = invalid === 'foreign transcript' ? new Transcript().id : content.transcript.id;
      await assert.rejects(runner.run({ transcriptId, index, message: { role: 'user', content: 'same text' } }));
      assert.deepEqual(content.view.members(), []);
      assert.equal(commits, 0);
      assert.equal(runner.isRunning, false);
    });
  }
});

test('management validates fixed View and memory ownership even when the requested member already exists', async (t) => {
  for (const mismatch of ['view identity', 'view scope', 'memory owner']) {
    await t.test(mismatch, async () => {
      const content = fixture(new Transcript([{ role: 'user', content: 'question' }]), [messageRef(0)]);
      const state = content.view.exportState();
      if (mismatch === 'memory owner') content.memories = new Memories(new Transcript());
      else content.view = new View({ ...state, sources: { ...state.sources, messages: { id: mismatch === 'view identity' ? new Transcript().id : content.transcript.id, scope: mismatch === 'view scope' ? 'keys:[0]' : 'whole' } } });
      const before = content.view.exportState();
      const runner = new Runner(new Scene(createMessageInclusion()), new Resources().register(new Resource(content), ConversationViewResource.manage)).build();
      await assert.rejects(runner.run({ transcriptId: content.transcript.id, index: 0, message: content.transcript.get(0) }));
      assert.equal(content.view.exportState(), before);
    });
  }
});

test('failed user maintenance preserves the input, prevents preparation and answer, and does not repair old membership later', async () => {
  const content = fixture();
  const attempts = [];
  const inputs = [];
  content.persistence = {
    commit(change) {
      attempts.push(change);
      if (attempts.length === 1) throw new Error('view save unavailable');
    },
  };
  let preparations = 0;
  const capture = createMaterialPreparation();
  const prepare = new Group().add({ capture });
  prepare.run = (work) => {
    preparations++;
    return work.children.capture.invoke(work.input);
  };
  const runner = assemble(content, new Node({ run: (work) => (inputs.push(work.input), 'answer') }), createMessageInclusion(), prepare);

  await assert.rejects(runner.run('failed maintenance'));
  assert.equal(preparations, 0);
  assert.equal(inputs.length, 0);
  assert.deepEqual(content.transcript.snapshot(), [{ role: 'user', content: 'failed maintenance' }]);
  assert.deepEqual(content.view.members(), []);
  assert.equal(runner.isRunning, false);
  assert.equal(await runner.run('next submission'), 'answer');
  assert.equal(preparations, 1);
  assert.equal(inputs[0].query.index, 1);
  assert.deepEqual(inputs[0].materials.entries, []);
  assert.deepEqual(content.view.members(), [1, 2].map(messageRef));
  assert.equal(attempts.length, 3, 'each accepted message is attempted once; the failed old input is not retried');
});

test('failed assistant maintenance preserves the stored and accepted answer while the entry fails and the next run stays independent', async () => {
  const content = fixture();
  const commits = [];
  const inputs = [];
  const events = [];
  const outputs = [];
  content.persistence = {
    commit(change) {
      commits.push(change);
      if (commits.length === 2) throw new Error('assistant membership save failed');
    },
  };
  const runner = assemble(content, new Node({ name: 'observed-answer', run: (work) => (inputs.push(work.input), `answer ${inputs.length}`) }), createMessageInclusion());
  runner.observation.subscribe(collect(events));
  runner.output.subscribe(collect(outputs));

  await assert.rejects(runner.run('first'));
  assert.deepEqual(content.transcript.snapshot(), [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer 1' },
  ]);
  assert.deepEqual(content.view.members(), [messageRef(0)]);
  assert.equal(
    outputs.some((event) => event.kind === 'completed'),
    false,
  );
  const answerId = events.find((event) => event.source === 'invocation' && event.fact.kind === 'started' && event.fact.description?.name === 'observed-answer')?.fact.identity.contextId;
  assert.ok(answerId);
  const answerAccepted = events.findIndex((event) => event.source === 'invocation' && event.fact.kind === 'relation' && event.fact.relation.childContextId === answerId && event.fact.phase === 'accepted');
  const assistantMaintenance = events.findLastIndex((event) => event.source === 'invocation' && event.fact.kind === 'started' && event.fact.description?.name === 'include-conversation-message');
  assert.ok(answerAccepted >= 0 && assistantMaintenance > answerAccepted);
  assert.equal(events.findLast((event) => event.source === 'entry' && event.fact.kind === 'settled').fact.status, 'failed');
  assert.equal(runner.isRunning, false);

  assert.equal(await runner.run('second'), 'answer 2');
  assert.equal(inputs.length, 2, 'later submission makes one new answer call, without replaying the saved answer');
  assert.deepEqual(
    inputs[1].materials.entries.map(({ key }) => key),
    [0],
  );
  assert.deepEqual(content.view.members(), [0, 2, 3].map(messageRef));
  assert.equal(content.transcript.get(1).content, 'answer 1');
  assert.equal(commits.length, 4);
});

test('a failed source append never invokes maintenance for an uncommitted user or assistant message', async (t) => {
  for (const role of ['user', 'assistant']) {
    await t.test(role, async () => {
      const transcript = new Transcript([], {
        persistence: {
          commit(change) {
            if (change.kind === 'append' && change.messages.some((message) => message.role === role)) throw new Error('transcript write failed');
          },
        },
      });
      const content = fixture(transcript);
      const maintained = [];
      const deps = { view: ConversationViewResource.manage.request() };
      const maintain = new Node({
        deps,
        run(work) {
          maintained.push(work.input);
          work.resources.view.include([messageRef(work.input.index)]);
        },
      });
      let answers = 0;
      const runner = assemble(content, new Node({ run: () => `answer ${++answers}` }), maintain);
      await assert.rejects(runner.run('question'));
      assert.deepEqual(
        maintained.map(({ message }) => message.role),
        role === 'user' ? [] : ['user'],
      );
      assert.equal(answers, role === 'user' ? 0 : 1);
      assert.equal(transcript.length, role === 'user' ? 0 : 1);
      assert.deepEqual(content.view.members(), role === 'user' ? [] : [messageRef(0)]);
      assert.equal(runner.isRunning, false);
    });
  }
});

test('management persistence receives a compare-and-swap basis and failed commits cannot install include, exclude or apply', async (t) => {
  for (const operation of ['include', 'exclude', 'apply']) {
    await t.test(operation, () => {
      const content = fixture(
        new Transcript([
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
        ]),
        [messageRef(0)],
      );
      const before = content.view.exportState();
      const attempts = [];
      let durable = { ...before, revision: 1 };
      content.persistence = {
        commit(change) {
          attempts.push(change);
          assert.equal(content.view.exportState(), before, 'persistence runs before membership installation');
          if (durable.revision !== change.previous.revision) throw new Error('persistent revision conflict');
          durable = change.state;
        },
      };
      const access = managerAccess(content);
      const manager = access.endpoints.view;
      const mutate = () => (operation === 'include' ? manager.include([messageRef(1)]) : operation === 'exclude' ? manager.exclude([messageRef(0)]) : manager.apply({ basis: manager.index().basis, members: [messageRef(1)] }));
      try {
        assert.throws(mutate, (error) => error instanceof PersistenceError && error.operation === 'view.commit' && error.cause?.message === 'persistent revision conflict');
        assert.equal(content.view.exportState(), before);
        assert.equal(attempts.length, 1, 'a CAS conflict is not automatically retried');
        assert.equal(attempts[0].previous, before);
        assert.equal(attempts[0].state.revision, 1);
        assert.deepEqual(Object.keys(attempts[0].checkedSources), operation === 'include' ? ['messages'] : operation === 'exclude' ? [] : ['messages', 'memories']);
      } finally {
        access.close();
      }
    });
  }
});

test('an invalid reference in a management batch prevents partial membership and persistence writes', () => {
  const content = fixture(new Transcript([{ role: 'user', content: 'one' }]));
  let commits = 0;
  content.persistence = { commit: () => void commits++ };
  const before = content.view.exportState();
  const access = managerAccess(content);
  try {
    assert.throws(() => access.endpoints.view.include([messageRef(0), messageRef(99)]));
    assert.equal(content.view.exportState(), before);
    assert.equal(content.view.has(messageRef(0)), false);
    assert.equal(commits, 0);
  } finally {
    access.close();
  }
});

test('cancelling a waiting maintenance call closes access without releasing actual execution or starting the answer', { timeout: 5000 }, async () => {
  const content = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const controller = new AbortController();
  const deps = { view: ConversationViewResource.manage.request() };
  let manager;
  let answers = 0;
  const maintain = new Node({
    deps,
    async run(work) {
      manager = work.resources.view;
      entered.resolve();
      await release.promise;
      manager.include([messageRef(work.input.index)]);
    },
  });
  const runner = assemble(content, new Node({ run: () => `answer ${++answers}` }), maintain);
  const running = runner.run('waiting user', { signal: controller.signal });
  const rejected = assert.rejects(running);
  await entered.promise;
  assert.equal(manager.has(messageRef(0)), false);
  assert.deepEqual(manager.capture().entries, []);
  controller.abort(new Error('stop this maintenance'));
  assert.equal(runner.isRunning, true);
  assert.throws(() => manager.include([]), 'even a no-op is unavailable after cancellation');
  assert.throws(() => manager.members());
  assert.throws(() => manager.index());
  release.resolve();
  await rejected;
  assert.equal(runner.isRunning, false);
  assert.equal(answers, 0);
  assert.deepEqual(content.view.members(), []);
  assert.deepEqual(content.transcript.snapshot(), [{ role: 'user', content: 'waiting user' }]);
});

test('management endpoints expire after each maintenance child while later calls receive independent active windows', async () => {
  const content = fixture();
  const managers = [];
  const baselines = [];
  const deps = { view: ConversationViewResource.manage.request() };
  const maintain = new Node({
    deps,
    run(work) {
      const manager = work.resources.view;
      managers.push(manager);
      manager.include([messageRef(work.input.index)]);
      baselines.push(manager.index());
    },
  });
  const runner = assemble(content, new Node({ run: () => 'answer' }), maintain);
  await runner.run('first');
  const manager = managers[0];
  for (const operation of [() => manager.has(messageRef(0)), () => manager.members(), () => manager.index(), () => manager.capture(), () => manager.include([]), () => manager.exclude([]), () => manager.apply({ basis: baselines[0].basis, members: [] })]) assert.throws(operation);
  assert.equal(await runner.run('second'), 'answer');
  assert.equal(new Set(managers).size, 4);
  assert.deepEqual(content.view.members(), [0, 1, 2, 3].map(messageRef));
});

test('a custom Group can choose when to invoke inclusion and prune membership through its own declared manager', async () => {
  const content = fixture();
  const include = createMessageInclusion();
  const deps = { view: ConversationViewResource.manage.request() };
  const maintain = new Group({ deps }).add({ include });
  const maintained = [];
  maintain.run = async (work) => {
    maintained.push(work.input);
    if (work.input.message.role === 'user') await work.children.include.invoke(work.input);
    else {
      const view = work.resources.view;
      const lastUser = view.members().at(-1);
      view.exclude(view.members().slice(0, -1));
      const index = view.index();
      view.apply({ basis: index.basis, members: lastUser ? [lastUser] : [] });
      assert.ok(view.capture().entries.every(({ value }) => value.role === 'user'));
    }
  };
  const histories = [];
  const answer = new Node({ run: (work) => (histories.push(work.input), 'answer') });
  const messages = new Resource(content.transcript);
  const resources = new Resources().register(messages, TranscriptResource.append).register(messages, HistoryResource).register(new Resource(content), ConversationViewResource.manage);
  const runner = new Runner(createConversationScene(answer, undefined, maintain), resources).build();
  await runner.run('first');
  await runner.run('second');
  assert.deepEqual(
    maintained.map(({ index, message }) => [index, message.role]),
    [
      [0, 'user'],
      [1, 'assistant'],
      [2, 'user'],
      [3, 'assistant'],
    ],
  );
  assert.ok(maintained.every((accepted) => accepted.transcriptId === content.transcript.id && Object.isFrozen(accepted)));
  assert.deepEqual(histories[1], [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
  ]);
  assert.deepEqual(content.view.members(), [messageRef(2)]);
  assert.equal(content.transcript.length, 4, 'excluding membership does not remove formal messages');
});

test('a maintenance structure has one owning Scene and cannot be reused across conversations', async () => {
  const maintain = createMessageInclusion();
  const answer = () => new Node({ run: () => 'answer' });
  const scene = createConversationScene(answer(), createMaterialPreparation(), maintain);
  assert.throws(() => createConversationScene(answer(), createMaterialPreparation(), maintain));
  const content = fixture();
  const resources = new Resources().register(new Resource(content.transcript), TranscriptResource.append).register(new Resource(content), ConversationViewResource.read).register(new Resource(content), ConversationViewResource.manage);
  const runner = new Runner(scene, resources).build();
  assert.equal(await runner.run('question'), 'answer');
  assert.deepEqual(content.view.members(), [0, 1].map(messageRef));
});
