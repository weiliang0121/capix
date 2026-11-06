import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from '@capix/diagnostics';
import { Node } from '@capix/structure';
import { createComparisonExample } from '../examples/parallel-analysis/assembly.mjs';
import { AnalysisUnavailable } from '../examples/parallel-analysis/structure.mjs';

const reply = (text) => ({ id: 'parallel-offline', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });
const inputOf = (request) => JSON.parse(request.messages.find((message) => message.role === 'user').content);
const deltas = (events) => events.filter((event) => event.kind === 'delta').map((event) => event.delta);
const relationsTo = (parent, child) => parent.value.relationChanges.filter((relation) => relation.childId === child.id).map((relation) => relation.change);

function observe(t, runner) {
  const events = [];
  const outputs = [];
  const names = new Map();
  const waiting = new Set();
  t.after(runner.output.subscribe({ receive: (event) => void outputs.push(event) }));
  t.after(
    runner.observation.subscribe({
      receive(event) {
        events.push(event);
        if (event.source === 'invocation' && event.fact.kind === 'started') names.set(event.fact.identity.contextId, event.fact.description?.name);
        for (const waiter of waiting) {
          if (!waiter.matches(event)) continue;
          waiting.delete(waiter);
          waiter.resolve(event);
        }
      },
    }),
  );
  return {
    events,
    outputs,
    relation(name, phase) {
      const matches = (event) => event.source === 'invocation' && event.fact.kind === 'relation' && event.fact.phase === phase && names.get(event.fact.relation.childContextId) === name;
      const existing = events.find(matches);
      if (existing) return Promise.resolve(existing);
      const gate = Promise.withResolvers();
      waiting.add({ matches, resolve: gate.resolve });
      return gate.promise;
    },
  };
}

function recorded(fixture) {
  const capture = fixture.recording.inspect(fixture.content).recording;
  assert.equal(capture.integrity, 'intact');
  assert.equal(capture.calls.length, 1);
  return fixture.recording.call(capture.calls[0].id);
}

test('parallel material branches overlap, preserve source identity on reverse completion, and expose only merge preview', { timeout: 5000 }, async (t) => {
  const gates = new Map();
  const bothStarted = Promise.withResolvers();
  const mergeStarted = Promise.withResolvers();
  const mergeRelease = Promise.withResolvers();
  const requests = [];
  const completionOrder = [];
  const model = {
    async complete(request, controls) {
      const input = inputOf(request);
      requests.push(input);
      assert.equal(request.stream, true);
      assert.equal(request.responseFormat, 'text');
      if (input.stage === 'analysis') {
        const gate = Promise.withResolvers();
        gates.set(input.material.index, gate);
        controls.emit(`private analysis preview ${input.material.index}`);
        if (gates.size === 2) bothStarted.resolve();
        const text = await gate.promise;
        completionOrder.push(input.material.index);
        return reply(text);
      }
      controls.emit('merged preview');
      mergeStarted.resolve(input);
      await mergeRelease.promise;
      return reply('formal comparison');
    },
  };
  const f = createComparisonExample({ model, recording: true });
  const observed = observe(t, f.runner);
  const running = f.runner.run('Compare the two release plans');
  await bothStarted.promise;
  assert.deepEqual([...gates.keys()], [0, 2]);
  assert.deepEqual(completionOrder, [], 'both requests are in flight before either can return');
  assert.deepEqual(deltas(observed.outputs), []);
  assert.equal(f.content.transcript.length, 4);

  gates.get(2).resolve('B keeps full testing');
  await observed.relation('analyze-secondary', 'accepted');
  assert.deepEqual(completionOrder, [2]);
  assert.equal(requests.length, 2, 'merge waits for both accepted results');
  gates.get(0).resolve('A releases sooner');
  const merged = await mergeStarted.promise;
  assert.deepEqual(completionOrder, [2, 0]);
  assert.deepEqual(merged.query, { transcriptId: f.content.transcript.id, index: 3, content: 'Compare the two release plans' });
  for (const [branch, index, analysis] of [
    ['primary', 0, 'A releases sooner'],
    ['secondary', 2, 'B keeps full testing'],
  ]) {
    assert.deepEqual(merged[branch], { status: 'available', material: { transcriptId: f.content.transcript.id, index, content: f.content.transcript.get(index).content }, analysis });
    const analysisInput = requests.find((request) => request.material?.index === index);
    assert.deepEqual(analysisInput.query, merged.query);
    assert.deepEqual(analysisInput.material, merged[branch].material);
    assert.deepEqual(Object.keys(analysisInput).sort(), ['material', 'query', 'stage'], 'a branch receives only its selected material');
  }
  assert.deepEqual(deltas(observed.outputs), ['merged preview']);
  assert.equal(f.content.transcript.length, 4, 'preview is not an assistant message');
  mergeRelease.resolve();
  assert.equal(await running, 'formal comparison');
  f.recording.stop();
  assert.deepEqual(f.content.transcript.snapshot().slice(3), [
    { role: 'user', content: 'Compare the two release plans' },
    { role: 'assistant', content: 'formal comparison' },
  ]);
  assert.equal(observed.outputs.filter((event) => event.kind === 'completed').length, 1);
  assert.equal(f.content.memories.values().length, 0);
  const detail = recorded(f);
  const comparison = detail.calls.find((call) => call.name === 'compare-materials');
  assert.equal(comparison.value.input.materials.basis.sources.messages.id, f.content.transcript.id);
  assert.equal(comparison.value.input.materials.basis.viewRevision, 0);
  assert.equal(detail.calls.filter((call) => call.name === 'complete-model-request').length, 3);
  for (const name of ['analyze-primary', 'analyze-secondary']) {
    const branch = detail.calls.find((call) => call.name === name);
    const changes = relationsTo(comparison, branch);
    assert.deepEqual(
      changes.map((change) => change.kind),
      ['returned', 'receiving', 'accepted'],
    );
    assert.equal(changes[0].result.status, 'succeeded');
    assert.equal(changes[2].output.status, 'available');
  }
  assert.ok(!JSON.stringify(detail).includes('private analysis preview'));
});

test('the secondary business exception stays a failed child return and an explicitly handled parent result', async (t) => {
  const unavailable = new AnalysisUnavailable('The secondary analysis is temporarily unavailable');
  let merged;
  const f = createComparisonExample({
    recording: true,
    model: {
      async complete(request, controls) {
        const input = inputOf(request);
        if (input.stage === 'analysis') {
          if (input.material.index === 2) throw unavailable;
          return reply('primary analysis');
        }
        merged = input;
        controls.emit('qualified answer');
        return reply('Primary is available; secondary could not be analyzed');
      },
    },
  });
  const observed = observe(t, f.runner);
  assert.equal(await f.runner.run('Compare'), 'Primary is available; secondary could not be analyzed');
  assert.equal(merged.primary.status, 'available');
  assert.deepEqual(merged.secondary, { status: 'unavailable', material: { transcriptId: f.content.transcript.id, index: 2, content: f.content.transcript.get(2).content }, reason: unavailable.message });
  assert.deepEqual(deltas(observed.outputs), ['qualified answer']);
  assert.equal(f.content.transcript.length, 5);
  const detail = recorded(f);
  const branch = detail.calls.find((call) => call.name === 'analyze-secondary');
  const parent = detail.calls.find((call) => call.id === branch.parentId);
  const changes = relationsTo(parent, branch);
  assert.equal(branch.status, 'failed');
  assert.equal(parent.status, 'succeeded');
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['returned', 'receiving', 'handled'],
  );
  assert.equal(changes[0].result.status, 'failed');
  assert.equal(changes[0].result.error.message, unavailable.message);
  assert.equal(changes[2].output.status, 'unavailable');
});

test('a primary failure prevents merging and keeps the parent occupied until its other child actually exits', { timeout: 5000 }, async (t) => {
  const primaryRelease = Promise.withResolvers();
  const secondaryRelease = Promise.withResolvers();
  const bothStarted = Promise.withResolvers();
  const failure = new AnalysisUnavailable('Primary is required even for this business exception');
  let started = 0;
  let merged = 0;
  let secondaryExited = false;
  const f = createComparisonExample({
    recording: true,
    model: {
      async complete(request) {
        const input = inputOf(request);
        if (input.stage === 'merge') {
          merged++;
          return reply('must not merge');
        }
        if (++started === 2) bothStarted.resolve();
        if (input.material.index === 0) {
          await primaryRelease.promise;
          throw failure;
        }
        await secondaryRelease.promise;
        secondaryExited = true;
        return reply('late secondary');
      },
    },
  });
  const observed = observe(t, f.runner);
  const running = f.runner.run('Compare');
  const rejected = assert.rejects(running, (error) => error === failure);
  await bothStarted.promise;
  primaryRelease.resolve();
  await observed.relation('analyze-primary', 'returned');
  assert.equal(f.runner.isRunning, true);
  assert.equal(secondaryExited, false);
  assert.equal(f.recording.stop().status, 'stopping');
  await assert.rejects(f.runner.run('busy'), { code: 'RUNTIME_BUSY' });
  assert.equal(f.content.transcript.length, 4);
  assert.ok(!observed.events.some((event) => event.source === 'entry' && event.fact.kind === 'released'));
  secondaryRelease.resolve();
  await rejected;
  assert.equal(secondaryExited, true);
  assert.equal(merged, 0);
  assert.equal(f.runner.isRunning, false);
  assert.equal(f.recording.state().status, 'stopped');
  assert.equal(f.content.transcript.length, 4);
  assert.equal(recorded(f).root.status, 'failed');
});

for (const failure of [new Error('Secondary transport failed'), new PersistenceError('secondary-save', new Error('disk failed'))]) {
  test(`secondary ${failure.constructor.name} propagates without a fallback or merge`, async () => {
    let merged = 0;
    const f = createComparisonExample({
      recording: true,
      model: {
        async complete(request) {
          const input = inputOf(request);
          if (input.stage === 'merge') {
            merged++;
            return reply('must not merge');
          }
          if (input.material.index === 2) throw failure;
          return reply('primary analysis');
        },
      },
    });
    await assert.rejects(f.runner.run('Compare'), (error) => error === failure);
    assert.equal(merged, 0);
    assert.equal(f.content.transcript.length, 4);
    const detail = recorded(f);
    const branch = detail.calls.find((call) => call.name === 'analyze-secondary');
    const parent = detail.calls.find((call) => call.id === branch.parentId);
    const changes = relationsTo(parent, branch);
    assert.equal(branch.status, 'failed');
    assert.equal(changes[0].kind, 'returned');
    assert.equal(changes[0].result.status, 'failed');
    assert.ok(!changes.some((change) => change.kind === 'handled'));
    if (!(failure instanceof PersistenceError))
      assert.deepEqual(
        changes.map((change) => change.kind),
        ['returned', 'receiving', 'failed'],
      );
  });
}

test('cancelling after one branch was accepted waits for the in-flight resource and allows a later run', { timeout: 5000 }, async (t) => {
  const secondaryEntered = Promise.withResolvers();
  const secondaryRelease = Promise.withResolvers();
  let secondaryControls;
  let secondaryExited = false;
  let merged = 0;
  const f = createComparisonExample({
    recording: true,
    model: {
      async complete(request, controls) {
        const input = inputOf(request);
        if (input.stage === 'merge') {
          merged++;
          controls.emit('next preview');
          return reply('next formal answer');
        }
        if (input.query.content === 'first' && input.material.index === 2) {
          secondaryControls = controls;
          secondaryEntered.resolve();
          await secondaryRelease.promise;
          secondaryExited = true;
        }
        return reply(`analysis ${input.material.index}`);
      },
    },
  });
  const observed = observe(t, f.runner);
  const running = f.runner.run('first');
  const rejected = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
  await secondaryEntered.promise;
  await observed.relation('analyze-primary', 'accepted');
  const reason = new Error('user stop');
  assert.equal(f.runner.cancel(reason), true);
  assert.equal(secondaryControls.signal.aborted, true);
  assert.equal(secondaryControls.signal.reason, reason);
  assert.equal(secondaryExited, false);
  assert.equal(f.runner.isRunning, true);
  assert.equal(f.recording.stop().status, 'stopping');
  await assert.rejects(f.runner.run('while still cancelling'), { code: 'RUNTIME_BUSY' });
  assert.equal(f.content.transcript.length, 4);
  assert.ok(!observed.events.some((event) => event.source === 'entry' && event.fact.kind === 'released'));
  secondaryRelease.resolve();
  await rejected;
  assert.throws(() => secondaryControls.emit('late internal preview'));
  assert.equal(secondaryExited, true);
  assert.equal(merged, 0);
  assert.equal(f.runner.isRunning, false);
  assert.equal(f.recording.state().status, 'stopped');
  assert.deepEqual(deltas(observed.outputs), []);
  assert.equal(f.content.transcript.length, 4);
  const failedDetail = recorded(f);
  const comparison = failedDetail.calls.find((call) => call.name === 'compare-materials');
  const primary = failedDetail.calls.find((call) => call.name === 'analyze-primary');
  assert.ok(
    relationsTo(comparison, primary).some((change) => change.kind === 'accepted'),
    'cancellation preserves the already accepted result',
  );
  assert.equal(await f.runner.run('next'), 'next formal answer');
  assert.equal(merged, 1);
  assert.deepEqual(f.content.transcript.snapshot().slice(3), [
    { role: 'user', content: 'first' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: 'next formal answer' },
  ]);
  assert.deepEqual(deltas(observed.outputs), ['next preview']);
});

test('a blank successful branch return fails parent acceptance without re-entering its failed receiver', async () => {
  let merged = 0;
  const f = createComparisonExample({
    recording: true,
    primary: new Node({ name: 'primary', run: () => 'primary analysis' }),
    secondary: new Node({ name: 'secondary', run: () => ' \n' }),
    merge: new Node({
      name: 'merge',
      run() {
        merged++;
        return 'must not merge';
      },
    }),
  });
  await assert.rejects(f.runner.run('Compare'), /nonblank text/);
  assert.equal(merged, 0);
  assert.equal(f.content.transcript.length, 4);
  const detail = recorded(f);
  const secondary = detail.calls.find((call) => call.name === 'secondary');
  const parent = detail.calls.find((call) => call.id === secondary.parentId);
  const changes = relationsTo(parent, secondary);
  assert.equal(secondary.status, 'succeeded', 'returned text is distinct from its acceptance');
  assert.equal(changes[0].result.status, 'succeeded');
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['returned', 'receiving', 'failed'],
  );
  assert.equal(parent.status, 'failed');
});

test('a provider emitting after cancellation adds a real output fault while the parent still waits for exit', { timeout: 5000 }, async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let secondaryControls;
  let outputFailure;
  let merged = 0;
  const f = createComparisonExample({
    recording: true,
    model: {
      async complete(request, controls) {
        const input = inputOf(request);
        if (input.stage === 'merge') {
          merged++;
          return reply('must not merge');
        }
        if (input.material.index === 2) {
          secondaryControls = controls;
          entered.resolve();
          await release.promise;
        }
        return reply('analysis');
      },
    },
  });
  const observed = observe(t, f.runner);
  const running = f.runner.run('Compare');
  const rejected = assert.rejects(running, (error) => error === outputFailure && error.code !== 'INVOCATION_CANCELLED');
  await entered.promise;
  await observed.relation('analyze-primary', 'accepted');
  assert.equal(f.runner.cancel(), true);
  assert.throws(
    () => secondaryControls.emit('invalid late preview'),
    (error) => {
      outputFailure = error;
      return /output is closed/.test(error.message);
    },
  );
  assert.equal(f.runner.isRunning, true, 'the new fault does not release the in-flight resource');
  assert.ok(!observed.events.some((event) => event.source === 'entry' && event.fact.kind === 'released'));
  await assert.rejects(f.runner.run('busy'), { code: 'RUNTIME_BUSY' });
  assert.equal(f.content.transcript.length, 4);
  release.resolve();
  await rejected;
  assert.equal(f.runner.isRunning, false);
  assert.equal(merged, 0);
  assert.deepEqual(deltas(observed.outputs), []);
  assert.equal(f.content.transcript.length, 4);
  assert.equal(observed.events.findLast((event) => event.source === 'entry' && event.fact.kind === 'settled').fact.status, 'failed');
  const detail = recorded(f);
  const secondary = detail.calls.find((call) => call.name === 'analyze-secondary');
  const comparison = detail.calls.find((call) => call.id === secondary.parentId);
  assert.ok(!relationsTo(comparison, secondary).some((change) => change.kind === 'handled'));
});

test('answer persistence failure preserves merge preview but never creates a formal assistant answer', async (t) => {
  const cause = new Error('answer store failed');
  let requests = 0;
  const f = createComparisonExample({
    recording: true,
    transcriptPersistence: {
      commit(change) {
        if (change.kind === 'append' && change.start >= 3 && change.messages.some((message) => message.role === 'assistant')) throw cause;
      },
    },
    model: {
      async complete(request, controls) {
        requests++;
        if (inputOf(request).stage === 'merge') controls.emit('merged preview');
        return reply('formal result');
      },
    },
  });
  const observed = observe(t, f.runner);
  await assert.rejects(f.runner.run('Compare'), (error) => error instanceof PersistenceError && error.cause === cause);
  assert.equal(requests, 3, 'no retry or alternate analysis is started');
  assert.equal(f.content.transcript.length, 4);
  assert.deepEqual(deltas(observed.outputs), ['merged preview']);
  assert.ok(!observed.outputs.some((event) => event.kind === 'completed'));
  assert.equal(recorded(f).root.status, 'failed');
});

test('both selected sources must exist in the captured material view before either analysis starts', async () => {
  let requests = 0;
  const f = createComparisonExample({
    model: {
      async complete() {
        requests++;
        return reply('must not run');
      },
    },
  });
  f.content.view.excludeSync([{ source: 'messages', key: 2 }]);
  await assert.rejects(f.runner.run('Compare'), /not in the fixed material view/);
  assert.equal(requests, 0);
  assert.equal(f.content.transcript.length, 4);
});

test('enabling recording leaves requests, previews, accepted content and final result equivalent', async (t) => {
  const results = [];
  for (const enabled of [false, true]) {
    const inputs = [];
    const f = createComparisonExample({
      recording: enabled,
      model: {
        async complete(request, controls) {
          const input = inputOf(request);
          inputs.push(input);
          controls.emit(input.stage === 'merge' ? 'public preview' : `private ${input.material.index}`);
          return reply(input.stage === 'merge' ? 'formal comparison' : `analysis ${input.material.index}`);
        },
      },
    });
    const observed = observe(t, f.runner);
    const result = await f.runner.run('Compare');
    results.push({ result, messages: f.content.transcript.snapshot(), previews: deltas(observed.outputs), requests: JSON.parse(JSON.stringify(inputs).replaceAll(f.content.transcript.id, 'transcript')) });
    const capture = f.recording.inspect(f.content).recording;
    assert.equal(capture.status, enabled ? 'recording' : 'idle');
    assert.equal(capture.calls.length, enabled ? 1 : 0);
    assert.equal(capture.integrity, 'intact');
  }
  assert.deepEqual(results[0], results[1]);
});
