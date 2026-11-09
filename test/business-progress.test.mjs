import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { ArchiveStore, PublicationArchive } from '../examples/business-progress/archive.mjs';
import { InteractionJournal, createGateway } from '../examples/business-progress/interaction.mjs';
import { ProgressStore, PublicationProgress, publicationOperation } from '../examples/business-progress/progress.mjs';
import { createPublicationRunner } from '../examples/business-progress/workflow.mjs';

function example(t, { inputs = ['发布安排'], send = (input) => `已生成：${input}`, snapshot } = {}) {
  const journal = snapshot ? InteractionJournal.restore(snapshot.interactions) : new InteractionJournal();
  const archiveStore = snapshot ? ArchiveStore.restore(snapshot.archive) : new ArchiveStore();
  const store = snapshot ? ProgressStore.restore(snapshot.progress) : new ProgressStore(inputs, archiveStore.id);
  let sends = 0;
  const host = createGateway(journal, (input) => {
    sends++;
    return send(input);
  });
  const archive = new PublicationArchive(archiveStore);
  const progress = new PublicationProgress(store, host.gateway, archive);
  const createRunner = () => createPublicationRunner({ progress, archive, gateway: host.gateway });
  const runner = createRunner();
  t.after(async () => {
    await host.interactions.settled();
    host.interactions.close();
  });
  return {
    ...host,
    journal,
    store,
    archiveStore,
    archive,
    progress,
    runner,
    createRunner,
    get sends() {
      return sends;
    },
    snapshot: () => JSON.parse(JSON.stringify({ interactions: journal.dump(), progress: store.dump(), archive: archiveStore.dump() })),
  };
}

async function advance(study, runner = study.runner) {
  const result = await runner.run();
  await study.interactions.settled();
  return result.status === 'pending' ? runner.run() : result;
}

test('business progress outlives a pending invocation; new calls consume late feedback and accept once', async (t) => {
  const response = Promise.withResolvers();
  t.after(() => response.resolve('late answer'));
  const study = example(t, { send: () => response.promise });
  const roots = [];
  study.runner.observation.subscribe({
    receive(event) {
      if (event.source === 'invocation' && event.fact.kind === 'started' && event.fact.identity.kind === 'scene') roots.push(event.fact.identity.contextId);
    },
  });
  const pending = await study.runner.run();
  assert.equal(pending.status, 'pending');
  assert.equal(study.runner.isRunning, false);
  assert.equal(study.interactions.active, true);
  const handoff = study.progress.read().items[0].reference;
  assert.ok(handoff);
  response.resolve('late answer');
  await study.interactions.settled();
  const accepted = await study.runner.run();
  assert.equal(accepted.status, 'accepted');
  assert.notEqual(roots[0], roots[1], 'business continuity does not restore the old invocation');
  const state = study.progress.read();
  assert.equal((await study.runner.run()).status, 'complete');
  assert.deepEqual(study.progress.read(), state);
  assert.equal(study.sends, 1);
  assert.equal(study.archiveStore.dump().entries.length, 1);
});

for (const [kind, timing] of [
  ['attach', 'before'],
  ['attach', 'after'],
  ['accept', 'before'],
  ['accept', 'after'],
]) {
  test(`fresh entities continue after progress ${kind}:${timing} without resending or duplicating the effect`, async (t) => {
    const study = example(t);
    study.store.failNext(kind, timing);
    await assert.rejects(advance(study), (error) => error instanceof PersistenceError);
    assert.equal(study.runner.isRunning, false);
    await study.interactions.settled();
    assert.equal(study.sends, 1);
    const snapshot = study.snapshot();
    if (kind === 'attach' && timing === 'before') assert.equal(snapshot.progress.items[0].reference, undefined, 'only the interaction-side formal index retains the handoff');
    if (kind === 'accept') assert.equal(snapshot.archive.entries.length, 1, 'the target effect preceded business acceptance');
    study.interactions.close();

    const reopened = example(t, { snapshot });
    const result = await advance(reopened);
    assert.equal(result.status, kind === 'accept' && timing === 'after' ? 'complete' : 'accepted');
    assert.equal(reopened.sends, 0);
    assert.equal(reopened.archiveStore.dump().entries.length, 1);
    const accepted = reopened.progress.read();
    assert.ok(accepted.items[0].acceptance);
    assert.equal(accepted.revision, 2);
    assert.equal((await reopened.runner.run()).status, 'complete');
    assert.deepEqual(reopened.progress.read(), accepted);
  });
}

for (const timing of ['before', 'after']) {
  test(`target ${timing}-commit failure is confirmed through target state, not through invocation outcome`, async (t) => {
    const study = example(t);
    study.archiveStore.failNext(timing);
    await assert.rejects(advance(study), (error) => error instanceof PersistenceError);
    await study.interactions.settled();
    const snapshot = study.snapshot();
    assert.equal(snapshot.archive.entries.length, timing === 'after' ? 1 : 0);
    assert.equal(snapshot.progress.items[0].acceptance, undefined);
    study.interactions.close();
    const reopened = example(t, { snapshot });
    const result = await advance(reopened);
    assert.equal(result.status, 'accepted');
    assert.equal(reopened.sends, 0);
    assert.equal(reopened.archiveStore.dump().entries.length, 1);
    if (timing === 'after') assert.deepEqual(result.receipt, snapshot.archive.entries[0].receipt);
  });
}

test('unknown target confirmation blocks publication and business advancement, even if an effect exists', async (t) => {
  const study = example(t, { inputs: ['first', 'second'] });
  study.store.failNext('accept', 'before');
  await assert.rejects(advance(study));
  await study.interactions.settled();
  const before = study.progress.read();
  study.archiveStore.setAvailable(false);
  assert.equal((await study.runner.run()).status, 'unknown');
  assert.deepEqual(study.progress.read(), before);
  assert.equal(study.sends, 1);
  assert.equal(study.archiveStore.dump().entries.length, 1);
  study.archiveStore.setAvailable(true);
  assert.equal((await study.runner.run()).status, 'accepted');
  assert.equal((await advance(study)).status, 'accepted');
  assert.equal(study.sends, 2);
  assert.equal(study.archiveStore.dump().entries.length, 2);
  assert.ok(study.progress.read().items.every((item) => item.acceptance));
});

test('two independent runners and entity instances share authority, not an invocation lock', async (t) => {
  const study = example(t);
  const otherArchive = new PublicationArchive(study.archiveStore);
  const otherProgress = new PublicationProgress(study.store, study.gateway, otherArchive);
  const other = createPublicationRunner({ progress: otherProgress, archive: otherArchive, gateway: study.gateway });
  const results = await Promise.all([advance(study), advance(study, other)]);
  assert.ok(results.every((result) => ['accepted', 'complete'].includes(result.status)));
  assert.equal(study.sends, 1);
  assert.equal(study.archiveStore.dump().entries.length, 1);
  assert.equal(study.progress.read().revision, 2, 'one handoff and one business acceptance, regardless of reader count');
});

test('fixed operations, handoffs, effect receipts and business acceptance are independently checked', async (t) => {
  const study = example(t);
  study.store.failNext('accept', 'before');
  await assert.rejects(advance(study));
  await study.interactions.settled();
  const state = study.progress.read();
  const item = state.items[0];
  const feedback = study.gateway.read(item.reference).feedback;
  const operation = publicationOperation(item, feedback);
  const receipt = study.archive.confirm(operation).receipt;
  assert.throws(() => study.gateway.establish({ ...item.generation, input: 'changed' }));
  assert.throws(() => study.progress.attach({ itemId: item.id, expectedRevision: state.revision, reference: { ...item.reference, id: 'unrelated' } }));
  assert.throws(() => study.archive.publish({ ...operation, input: { ...operation.input, text: 'changed' } }));
  assert.throws(() => study.progress.accept({ itemId: item.id, expectedRevision: state.revision, changeId: item.acceptanceId, receipt: { ...receipt, targetId: 'another-target' } }));
  assert.throws(() => study.progress.accept({ itemId: item.id, expectedRevision: state.revision, changeId: item.acceptanceId, receipt: { ...receipt, entryId: 'forged' } }));
  assert.throws(() => study.progress.accept({ itemId: item.id, expectedRevision: state.revision - 1, changeId: item.acceptanceId, receipt }), /revision/);
  assert.deepEqual(study.progress.read(), state);
  assert.equal((await study.runner.run()).status, 'accepted');
  const accepted = study.progress.read();
  assert.deepEqual(study.progress.accept({ itemId: item.id, expectedRevision: state.revision, changeId: item.acceptanceId, receipt }), accepted, 'same committed change remains confirmable with its original revision');
  assert.equal(study.sends, 1);
  assert.equal(study.archiveStore.dump().entries.length, 1);
});

test('a registered publication cannot move to another target after the first target committed', async (t) => {
  const study = example(t);
  study.store.failNext('accept', 'before');
  await assert.rejects(advance(study));
  await study.interactions.settled();
  const state = study.progress.read();
  const item = state.items[0];
  const operation = publicationOperation(item, study.gateway.read(item.reference).feedback);
  const otherStore = new ArchiveStore();
  const otherArchive = new PublicationArchive(otherStore);
  assert.throws(() => new PublicationProgress(study.store, study.gateway, otherArchive), /target identity/);
  assert.throws(() => otherArchive.publish(operation), /target/i);
  assert.equal(otherStore.dump().entries.length, 0);
  // 即便装配者把发布节点资源接错，操作里的目标身份仍在写入前保护目标。
  const wronglyWired = createPublicationRunner({ progress: study.progress, gateway: study.gateway, archive: otherArchive });
  await assert.rejects(wronglyWired.run(), /target/i);
  assert.equal(otherStore.dump().entries.length, 0);
  assert.deepEqual(study.progress.read(), state);
  assert.equal((await study.runner.run()).status, 'accepted');
  assert.equal(study.archiveStore.dump().entries.length, 1);
});

for (const point of ['create:after', 'started:before', 'started:after']) {
  test(`${point} preserves the operation reference but cannot promise dispatch recovery`, async (t) => {
    const study = example(t);
    study.journal.failNext(point);
    await assert.rejects(study.runner.run(), (error) => error instanceof PersistenceError);
    await study.interactions.settled();
    assert.equal(study.sends, 0);
    const snapshot = study.snapshot();
    study.interactions.close();
    const reopened = example(t, { snapshot });
    assert.equal((await reopened.runner.run()).status, 'unavailable');
    assert.equal((await reopened.runner.run()).status, 'unavailable');
    assert.equal(reopened.sends, 0);
    assert.equal(reopened.archiveStore.dump().entries.length, 0);
    assert.equal(reopened.progress.read().items[0].acceptance, undefined);
  });
}

test('failure before interaction creation is distinct from an unknown lookup outcome', async (t) => {
  const study = example(t);
  study.journal.failNext('create:before');
  await assert.rejects(study.runner.run(), (error) => error instanceof PersistenceError);
  assert.equal(study.sends, 0);
  study.journal.failNext('find');
  await assert.rejects(study.runner.run(), (error) => error instanceof PersistenceError);
  assert.equal(study.sends, 0, 'lookup failure cannot become permission to create');
  assert.equal((await advance(study)).status, 'accepted');
  assert.equal(study.sends, 1);
});
