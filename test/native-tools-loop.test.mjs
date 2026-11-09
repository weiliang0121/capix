import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Group, checkpointPoint, childReference } from '@weiliang0121/capix-structure';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { createFileTools } from '../examples/native-tools/tools.mjs';
import { createCatalog, tool } from '../examples/native-tools/catalog.mjs';
import { createHarness, defaultCatalog } from '../examples/native-tools/assembly.mjs';
import { ModelExchanges } from '../examples/native-tools/exchanges.mjs';
import { finalReply, toolReply } from '../examples/native-tools/fixtures.mjs';

async function completed(options = {}) {
  const harness = createHarness(options);
  const input = harness.input();
  assert.equal(await harness.runner.run(input), 'Translation saved.');
  await harness.close();
  return { harness, input, root: harness.checkpoints.writes[0].image.frame.owner.contextId };
}

function restore(harness, index, options = {}) {
  assert.ok(index >= 0, 'requested fixture boundary was actually saved');
  return createHarness({ checkpoints: harness.checkpoints.prefix(index), snapshot: harness.checkpoints.samples[index].snapshot, ...options });
}

test('native tool loop uses real children, handles expected failure, rejects unknown tool without a child', async () => {
  const { harness } = await completed();
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.files.reads, 2);
  assert.equal(harness.files.writes, 1);
  assert.equal(harness.files.files.get('summary.md'), 'translated');
  const entry = harness.exchanges.snapshot().entries[0];
  assert.deepEqual(
    entry.feedback.map((item) => item.status),
    ['ok', 'error', 'error'],
  );
  const final = harness.checkpoints.writes.findLast((write) => write.image?.contract.key === 'example.native-tools.loop').image;
  assert.equal(final.frame.children.length, 6);
  assert.equal(
    final.frame.children.some((child) => child.key === 'unknown'),
    false,
  );
  const failed = final.frame.children.find((child) => child.key === 'read-2');
  assert.equal(failed.state.kind, 'failed');
  assert.equal(failed.state.reception.kind, 'handled');
  for (const child of final.frame.children.filter((child) => child.key.startsWith('model:'))) assert.deepEqual(Object.keys(child.input), ['exchanges']);
});

for (const boundary of ['established', 'completed-model', 'accepted-model', 'handled-tool', 'completed-write', 'final']) {
  test(`restore at ${boundary} uses saved materials, exact relations and original interactions`, async () => {
    const { harness, input, root } = await completed();
    const index = harness.checkpoints.writes.findIndex((write) => {
      const image = write.image;
      if (!image) return false;
      if (boundary === 'established') return image.contract.key === 'example.native-tools.completion' && image.point === 'established';
      if (boundary === 'completed-model') return image.contract.key === 'example.native-tools.completion' && image.point === 'completed';
      if (boundary === 'accepted-model') return image.contract.key === 'example.native-tools.loop' && image.point === 'tools' && image.frame.children.length === 1;
      if (boundary === 'handled-tool') return image.contract.key === 'example.native-tools.loop' && image.frame.children.some((child) => child.key === 'read-2' && child.state.reception?.kind === 'handled');
      if (boundary === 'completed-write') return image.contract.key === 'example.native-tools.save_text' && image.point === 'completed';
      return image.contract.key === 'example.native-tools.loop' && image.point === 'completed';
    });
    let captures = 0;
    const afterFeedback = boundary === 'established' ? harness.feedbackCuts[0] : undefined;
    if (afterFeedback) assert.equal(afterFeedback.writeCount, index + 1, 'feedback persisted while the established checkpoint remained current');
    const restored = restore(harness, index, {
      ...(afterFeedback ? { snapshot: afterFeedback.snapshot } : {}),
      captureInput(original) {
        captures++;
        assert.deepEqual(original, input);
        return original;
      },
    });
    try {
      assert.equal(await restored.runner.resume(root), 'Translation saved.');
      assert.equal(captures, 1);
      assert.equal(restored.files.reads, 2);
      assert.equal(restored.files.writes, 1);
      for (const request of restored.requests) assert.equal(request.messages[0].content, input.materials);
      const knownRequests = new Set(harness.checkpoints.samples[index].snapshot.interactions.map((item) => JSON.stringify(item.request)));
      assert.ok(
        restored.requests.every((request) => !knownRequests.has(JSON.stringify(request))),
        'saved interactions are consumed, not resent',
      );
    } finally {
      await restored.close();
    }
  });
}

test('unknown model dispatch without first child checkpoint never creates a replacement request', async () => {
  const { harness, root } = await completed();
  const index = harness.checkpoints.writes.findIndex((write) => write.image?.point === 'modelWaiting');
  const restored = restore(harness, index, { model: () => assert.fail('unknown dispatch cannot send') });
  try {
    await assert.rejects(restored.runner.resume(root), /no durable continuation/);
  } finally {
    await restored.close();
  }
});

test('known interaction without feedback remains unavailable and is not resent', async () => {
  const { harness, root } = await completed();
  const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.completion' && write.image.point === 'established');
  const snapshot = structuredClone(harness.checkpoints.samples[index].snapshot);
  snapshot.interactions = snapshot.interactions.map(({ feedback, ...state }) => state);
  const restored = restore(harness, index, { snapshot, model: () => assert.fail('missing feedback cannot send') });
  try {
    await assert.rejects(restored.runner.resume(root), { code: 'INTERACTION_RESTORED_PENDING' });
  } finally {
    await restored.close();
  }
});

test('tool effect without first child checkpoint is unknown, never repeated', async () => {
  const { harness, root } = await completed();
  const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.loop' && write.image.state.active?.name === 'save_text');
  // This public persisted boundary contains a created tool relationship but no
  // child checkpoint. An external effect cannot be inferred absent or complete.
  const snapshot = structuredClone(harness.checkpoints.samples[index].snapshot);
  snapshot.files.push(['summary.md', 'external-effect-with-unknown-receipt']);
  snapshot.writes = 1;
  const restored = restore(harness, index, { snapshot });
  try {
    await assert.rejects(restored.runner.resume(root), /no durable continuation/);
    assert.equal(restored.files.writes, 1);
    assert.equal(restored.files.files.get('summary.md'), 'external-effect-with-unknown-receipt');
  } finally {
    await restored.close();
  }
});

test('changed directory is rejected before resource capture or sending', async () => {
  const { harness, root } = await completed();
  const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.completion');
  let captured = false;
  const restored = restore(harness, index, {
    catalog: defaultCatalog(2),
    captureInput() {
      captured = true;
      throw new Error('should not capture');
    },
  });
  try {
    await assert.rejects(restored.runner.resume(root), /catalog/);
    assert.equal(captured, false);
    assert.equal(restored.requests.length, 0);
  } finally {
    await restored.close();
  }
});

test('fixed slot accepts equal feedback and rejects conflicting values, foreign scope and incomplete prefixes', async () => {
  const { harness, input } = await completed();
  const restored = ModelExchanges.restore(harness.exchanges.snapshot());
  const first = restored.snapshot().entries[0];
  const ref = restored.ref(first);
  const previous = first.feedback[0];
  assert.deepEqual(restored.complete(input.scope, ref, previous.toolCallId, { status: previous.status, content: previous.content }, first.receptions.find((value) => value.callId === previous.toolCallId).operation), ref);
  assert.throws(() => restored.complete(input.scope, ref, previous.toolCallId, { status: 'ok', content: [{ kind: 'text', text: 'different' }] }), /conflicts/);
  assert.throws(() => restored.read('other-scope', ref), /scope/);
  assert.throws(() => restored.read(input.scope, { ...ref, collection: 'other' }), /scope/);
  assert.throws(() => restored.closed(input.scope, [ref, ref]), /Duplicate/);
  const incomplete = new ModelExchanges();
  const raw = harness.checkpoints.samples.find((sample) => sample.snapshot?.exchanges.entries.length === 1 && sample.snapshot.exchanges.entries[0].feedback.length === 0).snapshot.exchanges;
  const missing = ModelExchanges.restore(raw);
  assert.throws(() => missing.closed(input.scope, [missing.ref(missing.snapshot().entries[0])]), /missing/);
  assert.notEqual(incomplete.id, restored.id);
});

test('protected resource failure cannot become ordinary model-visible error feedback', async () => {
  const files = { files: new Map(), reads: 0, writes: 0 };
  files.files.has = () => {
    throw new PersistenceError('fixture.read', new Error('storage failed'));
  };
  const harness = createHarness({ toolSource: files });
  try {
    await assert.rejects(harness.runner.run(harness.input()));
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.exchanges.snapshot().entries[0].feedback.length, 0);
  } finally {
    await harness.close();
  }
});

test('two interleaved loops use their own captured material through the same offers', async () => {
  const first = createHarness({
    model: async (request) => {
      await new Promise((resolve) => setImmediate(resolve));
      return finalReply(request.messages[0].content);
    },
  });
  const second = createHarness({
    model: async (request) => {
      await new Promise((resolve) => setImmediate(resolve));
      return finalReply(request.messages[0].content);
    },
  });
  try {
    const values = await Promise.all([first.runner.run(first.input('alpha')), second.runner.run(second.input('beta'))]);
    assert.deepEqual(values, ['alpha', 'beta']);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test('reference input keeps base material out of every model checkpoint; reports writes and CPU boundaries', async () => {
  const harness = createHarness();
  try {
    await harness.runner.run(harness.input('large-material:'.repeat(10_000)));
    for (const write of harness.checkpoints.writes.filter((item) => item.image?.contract.key === 'example.native-tools.completion')) {
      assert.deepEqual(Object.keys(write.image.frame.input), ['exchanges']);
      assert.ok(JSON.stringify(write.image).length < 4096);
    }
    const cp = harness.checkpoints.report();
    assert.equal(cp.save, 23);
    assert.equal(cp.finish, 7);
    assert.ok(cp.points.every((point) => point.writerMs >= point.storeMs));
    assert.deepEqual(
      cp.points.filter((point) => point.contract === 'example.native-tools.loop').map((point) => point.children),
      [1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 6, 6, 6],
    );
    const interaction = harness.persistence.report();
    assert.equal(interaction.requests, 3);
    assert.equal(interaction.writes, 9);
    assert.ok(interaction.writtenBytes > interaction.retainedBytes);
  } finally {
    await harness.close();
  }
});

test('model-call budget has no hidden final-summary request', async () => {
  const harness = createHarness({ maxModelCalls: 1 });
  try {
    await assert.rejects(harness.runner.run(harness.input()), /budget/);
    assert.equal(harness.requests.length, 1);
  } finally {
    await harness.close();
  }
});

test('catalog cannot claim a different position or checkpoint contract for a registered tool', () => {
  for (const change of [{ position: 9 }, { contract: 'wrong' }, { version: 2 }]) {
    const entries = structuredClone(defaultCatalog().snapshot.entries);
    Object.assign(entries[0].member, change);
    assert.throws(() => createHarness({ catalog: createCatalog(entries) }), /Tool catalog changed/);
  }
});

for (const changed of ['reply', 'intake', 'feedback', 'provenance']) {
  test(`restore rejects exchange ${changed} inconsistent with exact accepted facts`, async () => {
    const { harness, root } = await completed();
    const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.loop' && write.image.point === 'completed');
    const snapshot = structuredClone(harness.checkpoints.samples[index].snapshot);
    if (changed === 'reply') snapshot.exchanges.entries.at(-1).reply.output[0].text = 'forged final';
    if (changed === 'intake') snapshot.exchanges.entries.at(-1).operation.childContextId = 'forged-child';
    if (changed === 'feedback') snapshot.exchanges.entries[0].feedback[0].content[0].text = 'forged tool';
    if (changed === 'provenance') snapshot.exchanges.entries[0].receptions[0].operation.childContextId = 'forged-child';
    const restored = restore(harness, index, { snapshot });
    try {
      await assert.rejects(restored.runner.resume(root), /differs/);
      assert.equal(restored.requests.length, 0);
    } finally {
      await restored.close();
    }
  });
}

test('cancellation closes local consumption while the independent interaction saves its late reply', async () => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const harness = createHarness({
    model: async () => {
      started.resolve();
      await gate.promise;
      return finalReply('late');
    },
  });
  const result = harness.runner.run(harness.input());
  const rejected = assert.rejects(result);
  try {
    await started.promise;
    assert.equal(harness.runner.cancel(new Error('stop local call')), true);
    await rejected;
    assert.equal(harness.exchanges.snapshot().entries.length, 0);
    gate.resolve();
    await harness.interactions.settled();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.persistence.snapshot()[0].feedback.payload.output[0].text, 'late');
  } finally {
    gate.resolve();
    await harness.close();
  }
});

test('large repeated tool results remain entity references in model inputs while Interaction keeps full requests', async () => {
  const toolSource = { files: new Map([['notes.md', 'x'.repeat(64 * 1024)]]), reads: 0, writes: 0 };
  const harness = createHarness({
    toolSource,
    retainSnapshots: false,
    model(request) {
      const step = request.messages.filter((message) => message.role === 'assistant').length;
      return step < 3 ? toolReply([{ id: 'reused-id', name: 'read_text', arguments: '{"path":"notes.md"}' }], { id: `step-${step}` }) : finalReply('done');
    },
  });
  try {
    assert.equal(await harness.runner.run(harness.input()), 'done');
    assert.equal(harness.files.reads, 3);
    for (const write of harness.checkpoints.writes.filter((item) => item.image?.contract.key === 'example.native-tools.completion')) {
      assert.ok(JSON.stringify(write.image).length < 5000);
    }
    const sizes = harness.requests.map((request) => Buffer.byteLength(JSON.stringify(request)));
    assert.ok(sizes[3] > 3 * 64 * 1024);
    assert.ok(sizes.every((size, index) => index === 0 || size > sizes[index - 1]));
  } finally {
    await harness.close();
  }
});

test('changed model-call budget is rejected before resource recapture', async () => {
  const { harness, root } = await completed();
  const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.completion');
  let captured = false;
  const restored = restore(harness, index, {
    maxModelCalls: 7,
    captureInput() {
      captured = true;
      throw new Error('unexpected capture');
    },
  });
  try {
    await assert.rejects(restored.runner.resume(root), /budget/);
    assert.equal(captured, false);
    assert.equal(restored.requests.length, 0);
  } finally {
    await restored.close();
  }
});

function readOnce(path = 'notes.md') {
  return (request) => (request.messages.some((message) => message.role === 'tool') ? finalReply('done') : toolReply([{ id: 'call-read', name: 'read_text', arguments: JSON.stringify({ path }) }]));
}

function mapRead(result) {
  return (write) => {
    const registrations = createFileTools(write);
    const original = registrations.read_text;
    return { ...registrations, read_text: tool(original.node, { description: original.description, input: original.input, result }) };
  };
}
const feedback = (status, text) => ({ status, content: [{ kind: 'text', text }] });

for (const variant of ['successful-error', 'failed-ok']) {
  test(`real tool registration can map ${variant} without rewriting child facts`, async () => {
    const path = variant === 'failed-ok' ? 'missing.md' : 'notes.md';
    let mappings = 0;
    const tools = mapRead({
      succeeded() {
        mappings++;
        return feedback('error', 'business rejected value');
      },
      failed() {
        mappings++;
        return feedback('ok', 'replacement');
      },
    });
    const harness = createHarness({ model: readOnce(path), policyVersion: 'mapping-v1', tools });
    try {
      assert.equal(await harness.runner.run(harness.input()), 'done');
      const entry = harness.exchanges.snapshot().entries[0];
      assert.equal(entry.feedback[0].status, variant === 'failed-ok' ? 'ok' : 'error');
      const frame = harness.checkpoints.writes.findLast((write) => write.image?.contract.key === 'example.native-tools.loop').image.frame;
      const child = frame.children.find((item) => item.key === 'call-read');
      assert.equal(child.state.kind, variant === 'failed-ok' ? 'failed' : 'returned');
      assert.equal(child.state.reception.kind, variant === 'failed-ok' ? 'handled' : 'accepted');
      assert.equal(mappings, 1);
      const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.loop' && write.image.point === 'tools' && write.image.state.cursor === 1);
      const root = harness.checkpoints.writes[0].image.frame.owner.contextId;
      mappings = 0;
      const restored = restore(harness, index, { model: readOnce(path), policyVersion: 'mapping-v1', tools });
      try {
        assert.equal(await restored.runner.resume(root), 'done');
        assert.equal(mappings, 0);
        const recovered = restored.checkpoints.writes.findLast((write) => write.image?.contract.key === 'example.native-tools.loop').image.frame.children.find((item) => item.key === 'call-read');
        assert.deepEqual(recovered.state, child.state);
        assert.deepEqual(restored.exchanges.snapshot().entries[0].feedback, entry.feedback);
      } finally {
        await restored.close();
      }
    } finally {
      await harness.close();
    }
  });
}

test('real tool registration without failed propagates the original business failure', async () => {
  const harness = createHarness({ model: readOnce('missing.md'), tools: mapRead({ succeeded: (value) => feedback('ok', value) }) });
  try {
    await assert.rejects(harness.runner.run(harness.input()), /Missing file/);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.exchanges.snapshot().entries[0].feedback.length, 0);
  } finally {
    await harness.close();
  }
});

for (const branch of ['succeeded', 'failed']) {
  test(`throwing ${branch} mapping does not reenter failed or write a replacement feedback`, async () => {
    let failures = 0;
    const harness = createHarness({
      model: readOnce(branch === 'failed' ? 'missing.md' : 'notes.md'),
      tools: mapRead({
        succeeded() {
          throw new Error('mapping failed');
        },
        failed() {
          failures++;
          throw new Error('mapping failed');
        },
      }),
    });
    try {
      await assert.rejects(harness.runner.run(harness.input()), /mapping failed/);
      assert.equal(failures, branch === 'failed' ? 1 : 0);
      assert.equal(harness.requests.length, 1);
      assert.equal(harness.exchanges.snapshot().entries[0].feedback.length, 0);
    } finally {
      await harness.close();
    }
  });
}

test('protected tool failure bypasses even an author failed handler that returns ok', async () => {
  let failures = 0;
  const files = { files: new Map(), reads: 0, writes: 0 };
  files.files.has = () => {
    throw new PersistenceError('fixture.read', new Error('storage failed'));
  };
  const harness = createHarness({
    toolSource: files,
    model: readOnce(),
    tools: mapRead({
      succeeded: () => feedback('ok', 'unused'),
      failed: () => {
        failures++;
        return feedback('ok', 'should not run');
      },
    }),
  });
  try {
    await assert.rejects(harness.runner.run(harness.input()));
    assert.equal(failures, 0);
    assert.equal(harness.exchanges.snapshot().entries[0].feedback.length, 0);
  } finally {
    await harness.close();
  }
});

test('the registered input parser rejects values absent from its JSON Schema without a tool child', async () => {
  let parsed = 0;
  const harness = createHarness({
    model: readOnce('not-permitted.md'),
    tools(write) {
      const registrations = createFileTools(write);
      const original = registrations.read_text;
      const input = z.strictObject({ path: z.string() }).refine((value) => {
        parsed++;
        return value.path === 'notes.md';
      });
      return { ...registrations, read_text: tool(original.node, { description: original.description, input, result: original.result }) };
    },
  });
  try {
    assert.equal(await harness.runner.run(harness.input()), 'done');
    assert.ok(parsed > 0);
    assert.equal(harness.files.reads, 0);
    assert.equal(harness.exchanges.snapshot().entries[0].feedback[0].status, 'error');
    const frame = harness.checkpoints.writes.findLast((write) => write.image?.contract.key === 'example.native-tools.loop').image.frame;
    assert.equal(
      frame.children.some((item) => item.key === 'call-read'),
      false,
    );
  } finally {
    await harness.close();
  }
});

test('Group registration executes its real child and resumed accepted feedback does not rerun mappings', async () => {
  let mapped = 0;
  function tools(write) {
    const registrations = createFileTools(write);
    const original = registrations.read_text;
    const point = checkpointPoint()({ name: 'read', state: { encode: () => null, decode: () => null }, references: { read: childReference(original.node) }, resume: { uses: [original.node], run: (work, _state, refs) => work.children.resume(refs.read).invoke() } });
    const group = new Group({ name: 'read-group', checkpoint: { key: 'example.native-tools.read-group', version: 1, input: original.node.checkpoint.input, output: original.node.checkpoint.output, points: [point] } }).add({ read: original.node });
    group.run = (work) => {
      const child = work.children.create(original.node, work.input);
      write(work, { point, state: null, refs: { read: child.ref } });
      return child.invoke();
    };
    return {
      ...registrations,
      read_text: tool(group, {
        description: original.description,
        input: original.input,
        result: {
          succeeded(value) {
            mapped++;
            return feedback('error', value);
          },
        },
      }),
    };
  }
  const harness = createHarness({ model: readOnce(), policyVersion: 'group-map-v1', tools });
  await harness.runner.run(harness.input());
  await harness.close();
  const root = harness.checkpoints.writes[0].image.frame.owner.contextId;
  const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.loop' && write.image.point === 'tools' && write.image.state.cursor === 1);
  const originalFeedback = harness.exchanges.snapshot().entries[0].feedback;
  mapped = 0;
  const restored = restore(harness, index, { tools, policyVersion: 'group-map-v1', model: readOnce() });
  try {
    assert.equal(await restored.runner.resume(root), 'done');
    assert.equal(mapped, 0);
    assert.equal(restored.files.reads, 1);
    assert.deepEqual(restored.exchanges.snapshot().entries[0].feedback, originalFeedback);
  } finally {
    await restored.close();
  }
});

test('changing the explicit feedback policy version refuses old CP before new mappings can run', async () => {
  const { harness, root } = await completed();
  const index = harness.checkpoints.writes.findIndex((write) => write.image?.contract.key === 'example.native-tools.loop' && write.image.point === 'tools');
  let mapped = false;
  const restored = restore(harness, index, {
    policyVersion: 'replacement-v2',
    tools: mapRead({
      succeeded() {
        mapped = true;
        return feedback('error', 'new');
      },
    }),
  });
  try {
    await assert.rejects(restored.runner.resume(root), /catalog/);
    assert.equal(mapped, false);
    assert.equal(restored.requests.length, 0);
  } finally {
    await restored.close();
  }
});

test('registered parser cannot silently change the model arguments before dispatch', async () => {
  const harness = createHarness({
    model: readOnce(' notes.md '),
    tools(write) {
      const registrations = createFileTools(write);
      const original = registrations.read_text;
      return { ...registrations, read_text: tool(original.node, { description: original.description, input: z.strictObject({ path: z.string().trim() }), result: original.result }) };
    },
  });
  try {
    await assert.rejects(harness.runner.run(harness.input()), /preserve.*argument/);
    assert.equal(harness.files.reads, 0);
    assert.equal(harness.requests.length, 1);
  } finally {
    await harness.close();
  }
});

test('two loops sharing one exchange entity retain independent host scopes and material chains', async () => {
  const exchanges = new ModelExchanges();
  async function model(request) {
    await new Promise((resolve) => setImmediate(resolve));
    return request.messages.some((message) => message.role === 'tool') ? finalReply(request.messages[0].content) : toolReply([{ id: 'same-call-id', name: 'read_text', arguments: '{"path":"notes.md"}' }]);
  }
  const first = createHarness({ exchanges, model, toolSource: { files: new Map([['notes.md', 'first source']]), reads: 0, writes: 0 } });
  const second = createHarness({ exchanges, model, toolSource: { files: new Map([['notes.md', 'second source']]), reads: 0, writes: 0 } });
  try {
    const inputA = first.input('alpha');
    const inputB = second.input('beta');
    assert.notEqual(inputA.scope, inputB.scope);
    assert.deepEqual(await Promise.all([first.runner.run(inputA), second.runner.run(inputB)]), ['alpha', 'beta']);
    const entries = exchanges.snapshot().entries;
    assert.equal(entries.length, 4);
    assert.equal(entries.find((entry) => entry.scope === inputA.scope && entry.feedback.length).feedback[0].content[0].text, 'first source');
    assert.equal(entries.find((entry) => entry.scope === inputB.scope && entry.feedback.length).feedback[0].content[0].text, 'second source');
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
