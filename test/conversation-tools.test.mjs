import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Node, Group, Scene, checkpointPoint, childReference } from '@capix/structure';
import { Resource, ResourceOffer } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { ModelExchanges } from '@capix/model-exchanges';
import { Interactions } from '@capix/interaction';
import { PersistenceError } from '@capix/diagnostics';
import { requireModelReply, requireModelRequest } from '@capix/model-provider';
import { createToolLoop, createToolAnswer, registerToolLoopResources, tool, toolLoopInputCodec } from '@capix/conversation-service/tools';

const copy = (value) => structuredClone(value);
const textCodec = { encode: (value) => z.string().parse(value), decode: (value) => z.string().parse(value) };
const inputSchema = z.strictObject({ path: z.string() });
const inputCodec = { encode: (value) => inputSchema.parse(value), decode: (value) => inputSchema.parse(value) };
const contract = { key: 'test.production-tools.v1', request: requireModelRequest, reply: requireModelReply };
const result = (status, text) => ({ status, content: [{ kind: 'text', text }] });
function reply(output, reason = 'stop') {
  return requireModelReply({ formatVersion: 1, id: 'response', model: 'fixture', output, termination: { kind: 'completed', reason }, usage: null, native: { format: 'chat-completions', version: 1 } });
}
const final = (text = 'done') => reply([{ kind: 'text', text }]);
const call = (id, name, input) => ({ kind: 'tool-call', id, name, arguments: { encoding: 'json-text', text: JSON.stringify(input) } });
function model(request) {
  return request.exchanges.length ? final() : reply([call('read-1', 'read', { path: 'notes' }), call('read-2', 'read', { path: 'missing' }), call('bad', 'unknown', {})], 'tool_calls');
}
class Missing extends Error {}
const Files = new ResourceOffer({
  methods: {
    read(source, { path }) {
      source.reads++;
      if (!source.files.has(path)) throw new Missing('file missing');
      return source.files.get(path);
    },
  },
});
function registrations({ checkpoint = true, group = false, mapping, parser = inputSchema } = {}) {
  const done = checkpointPoint()({ name: 'done', state: textCodec, references: {}, resume: { run: (_work, value) => value } });
  const node = new Node({
    deps: { files: Files.request() },
    ...(checkpoint ? { checkpoint: { key: 'test.tools.read', version: 1, input: inputCodec, output: textCodec, points: [done] } } : {}),
    async run(work) {
      const value = await work.resources.files.read(work.input);
      work.checkpoint?.({ point: done, state: value, refs: {} });
      return value;
    },
  });
  let member = node;
  if (group) {
    const waiting = checkpointPoint()({ name: 'waiting', state: { encode: () => null, decode: () => null }, references: { read: childReference(node) }, resume: { uses: [node], run: (work, _state, refs) => work.children.resume(refs.read).invoke() } });
    member = new Group({ ...(checkpoint ? { checkpoint: { key: 'test.tools.read-group', version: 1, input: inputCodec, output: textCodec, points: [waiting] } } : {}) }).add({ read: node });
    member.run = (work) => {
      const child = work.children.create(node, work.input);
      work.checkpoint?.({ point: waiting, state: null, refs: { read: child.ref } });
      return child.invoke();
    };
  }
  return {
    read: tool(member, {
      description: 'Read a named text document.',
      input: parser,
      result: mapping ?? {
        succeeded: (value) => result('ok', value),
        failed(error) {
          if (!(error instanceof Missing)) throw error;
          return result('error', error.message);
        },
      },
    }),
  };
}
class Journal extends MemoryCheckpointStore {
  writes = [];
  cuts = [];
  capture = () => undefined;
  save(image, revision) {
    const value = super.save(image, revision);
    this.writes.push({ image: this.read(value.contextId).image, commit: image, revision });
    this.cuts.push(this.capture());
    return value;
  }
  finish(id, revision, delivery) {
    const value = super.finish(id, revision, delivery);
    this.writes.push({ id, revision, delivery: this.read(id).delivery });
    this.cuts.push(this.capture());
    return value;
  }
  prefix(index) {
    const next = new Journal();
    for (const value of this.writes.slice(0, index + 1)) {
      if (value.image) next.save(value.commit ?? value.image, value.revision);
      else next.finish(value.id, value.revision, value.delivery);
    }
    next.writes = [];
    next.cuts = [];
    return next;
  }
}
function harness({ checkpoint = true, group = false, mapping, parser, nextModel = model, state, checkpoints = new Journal(), policyVersion = 'test-v1', maxModelCalls = 8, waitMs = 1000, budgets, files, receiveFailure } = {}) {
  const exchanges = state ? ModelExchanges.restore(state.exchanges) : new ModelExchanges();
  const source = files ?? { files: new Map(state?.files ?? [['notes', 'original']]), reads: state?.reads ?? 0 };
  const persisted = new Map(state?.interactions.map((item) => [item.id, item]));
  const requests = [];
  const interactions = new Interactions().register(contract, {
    persistence: {
      read: (id) => persisted.get(id),
      create(value) {
        persisted.set(value.id, copy(value));
      },
      commit({ expectedRevision, state }) {
        assert.equal(persisted.get(state.id).revision, expectedRevision);
        persisted.set(state.id, copy(state));
      },
    },
    send(request) {
      requests.push(copy(request));
      return nextModel(request);
    },
  });
  const loop = createToolLoop({ tools: registrations({ checkpoint, group, mapping, parser }), policyVersion, checkpoint, maxModelCalls, waitMs, budgets });
  const resources = new Resources().register(new Resource(source), Files);
  registerToolLoopResources(resources, loop, exchanges, interactions.bind(contract), { read: (id) => persisted.get(id) });
  const invokeRoot = (child) => child.invoke(receiveFailure ? { result: { failed: receiveFailure } } : {});
  const rootPoint = checkpointPoint()({ name: 'waiting', state: { encode: () => null, decode: () => null }, references: { loop: childReference(loop) }, check: (_state, facts) => assert.deepEqual(facts.references.loop.input, facts.input), resume: { uses: [loop], run: (work, _state, refs) => invokeRoot(work.children.resume(refs.loop)) } });
  const scene = checkpoint ? new Scene({ checkpoint: { key: 'test.tools.scene', version: 1, input: toolLoopInputCodec, output: textCodec, points: [rootPoint] } }).add({ loop }) : new Scene(loop);
  if (checkpoint)
    scene.run = (work) => {
      const child = work.children.create(loop, work.input);
      work.checkpoint({ point: rootPoint, state: null, refs: { loop: child.ref } });
      return child.invoke();
    };
  const runner = new Runner(scene, resources, interactions, { checkpoints: { store: checkpoints } }).build();
  const capture = () => copy({ exchanges: exchanges.snapshot(), interactions: [...persisted.values()], files: [...source.files], reads: source.reads });
  checkpoints.capture = capture;
  return {
    runner,
    loop,
    exchanges,
    source,
    requests,
    checkpoints,
    persisted,
    interactions,
    input: (text = 'hello') => loop.input({ messages: [{ role: 'user', content: text }] }),
    capture,
    async close() {
      await interactions.settled();
      interactions.close();
    },
  };
}
function oneCall(path = 'notes') {
  return (request) => (request.exchanges.length ? final() : reply([call('read', 'read', { path })], 'tool_calls'));
}

test('production ToolLoop executes registered tools, expected failure and precheck feedback', async () => {
  const h = harness();
  try {
    assert.equal(await h.runner.run(h.input()), 'done');
    assert.equal(h.requests.length, 2);
    assert.equal(h.source.reads, 2);
    assert.deepEqual(
      h.exchanges.snapshot().entries[0].feedback.map((value) => value.status),
      ['ok', 'error', 'error'],
    );
    const image = h.checkpoints.writes.findLast((item) => item.image?.contract.key === 'conversation.tools.loop').image;
    assert.equal(image.frame.children.length, 4);
    assert.equal(image.frame.children.find((item) => item.key === 'read-2').state.reception.kind, 'handled');
    for (const item of h.checkpoints.writes.filter((item) => item.image?.contract.key === 'conversation.tools.completion')) assert.deepEqual(Object.keys(item.image.frame.input), ['exchanges']);
  } finally {
    await h.close();
  }
});
test('ordinary no-CP Node and Group tools do not acquire a recovery requirement', async () => {
  for (const group of [false, true]) {
    const h = harness({ checkpoint: false, group, nextModel: oneCall() });
    try {
      assert.equal(await h.runner.run(h.input()), 'done');
      assert.equal(h.checkpoints.writes.length, 0);
    } finally {
      await h.close();
    }
  }
  assert.throws(() => createToolLoop({ tools: registrations({ checkpoint: false }), policyVersion: 'v1', checkpoint: true }), /checkpoint contracts/);
});
for (const variant of ['success-error', 'failure-ok'])
  test(`production tool mapping ${variant} keeps real child facts`, async () => {
    const h = harness({ nextModel: oneCall(variant === 'failure-ok' ? 'missing' : 'notes'), mapping: { succeeded: () => result('error', 'business decision'), failed: () => result('ok', 'replacement') } });
    try {
      assert.equal(await h.runner.run(h.input()), 'done');
      const entry = h.exchanges.snapshot().entries[0];
      assert.equal(entry.feedback[0].status, variant === 'failure-ok' ? 'ok' : 'error');
      const image = h.checkpoints.writes.findLast((item) => item.image?.contract.key === 'conversation.tools.loop').image;
      const child = image.frame.children.find((item) => item.key === 'read');
      assert.equal(child.state.kind, variant === 'failure-ok' ? 'failed' : 'returned');
      assert.equal(child.state.reception.kind, variant === 'failure-ok' ? 'handled' : 'accepted');
    } finally {
      await h.close();
    }
  });
test('mapping failures do not reenter failed and protected failures cannot be handled', async () => {
  let handled = 0;
  const h = harness({
    nextModel: oneCall(),
    mapping: {
      succeeded() {
        throw new Error('mapping broke');
      },
      failed() {
        handled++;
        return result('ok', 'replacement');
      },
    },
  });
  try {
    await assert.rejects(h.runner.run(h.input()), /mapping broke/);
    assert.equal(handled, 0);
    assert.equal(h.exchanges.snapshot().entries[0].feedback.length, 0);
  } finally {
    await h.close();
  }
  const files = { files: new Map(), reads: 0 };
  files.files.has = () => {
    throw new PersistenceError('tools.read', new Error('storage failed'));
  };
  const protectedRun = harness({
    files,
    nextModel: oneCall(),
    mapping: {
      succeeded: () => result('ok', 'unused'),
      failed() {
        handled++;
        return result('ok', 'replacement');
      },
    },
  });
  try {
    await assert.rejects(protectedRun.runner.run(protectedRun.input()));
    assert.equal(handled, 0);
  } finally {
    await protectedRun.close();
  }
});
test('unconfigured failed propagates and refined input cannot silently rewrite model arguments', async () => {
  const h = harness({ nextModel: oneCall('missing'), mapping: { succeeded: (value) => result('ok', value) } });
  try {
    await assert.rejects(h.runner.run(h.input()), /file missing/);
    assert.equal(h.requests.length, 1);
  } finally {
    await h.close();
  }
  const altered = harness({ nextModel: oneCall(' notes '), parser: z.strictObject({ path: z.string().trim() }) });
  try {
    await assert.rejects(altered.runner.run(altered.input()), /preserve/);
    assert.equal(altered.source.reads, 0);
  } finally {
    await altered.close();
  }
});
for (const boundary of ['model-completed', 'accepted-model', 'handled-tool', 'final'])
  test(`production CP restoration at ${boundary} keeps fixed inputs and effects`, async () => {
    const h = harness();
    const input = h.input('fixed basis');
    await h.runner.run(input);
    await h.close();
    const index = h.checkpoints.writes.findIndex(({ image }) => image && (boundary === 'model-completed' ? image.contract.key === 'conversation.tools.completion' && image.point === 'completed' : boundary === 'accepted-model' ? image.contract.key === 'conversation.tools.loop' && image.point === 'tools' && image.state.cursor === 0 && image.state.active === null : boundary === 'handled-tool' ? image.contract.key === 'conversation.tools.loop' && image.state.cursor === 2 : image.contract.key === 'conversation.tools.loop' && image.point === 'completed'));
    const loopId = h.checkpoints.writes.find(({ image }) => image?.contract.key === 'conversation.tools.loop').image.frame.owner.contextId;
    // Resume the loop directly with a new Scene and supply; its root identity is its original scene root.
    const oldRoot = h.checkpoints.writes[0].image.frame.owner.contextId;
    assert.notEqual(oldRoot, loopId);
    const restored = harness({ state: h.checkpoints.cuts[index], checkpoints: h.checkpoints.prefix(index) });
    try {
      assert.equal(await restored.runner.resume(oldRoot), 'done');
      assert.equal(restored.source.reads, 2);
      for (const request of restored.requests) assert.equal(request.messages[0].content, 'fixed basis');
    } finally {
      await restored.close();
    }
  });

test('ToolLoop fixed configuration is immutable and cannot drift between capture and execution', async () => {
  const h = harness();
  try {
    for (const [key, value] of [
      ['catalog', { digest: 'changed' }],
      ['maxModelCalls', 32],
      ['waitMs', 0],
      ['recoverable', false],
    ])
      assert.equal(Reflect.set(h.loop, key, value), false);
    assert.throws(() => {
      h.loop.catalog.tools[0].parameters.properties.path.type = 'number';
    }, TypeError);
    assert.equal(await h.runner.run(h.input()), 'done');
  } finally {
    await h.close();
  }
});
for (const changed of [{ policyVersion: 'new-v2' }, { maxModelCalls: 7 }, { waitMs: 999 }, { budgets: { maxFeedbackBytes: 2048 } }])
  test(`production recovery rejects changed fixed options ${JSON.stringify(changed)}`, async () => {
    const h = harness();
    await h.runner.run(h.input());
    await h.close();
    const index = h.checkpoints.writes.findIndex(({ image }) => image?.contract.key === 'conversation.tools.loop' && image.point === 'tools');
    const root = h.checkpoints.writes[0].image.frame.owner.contextId;
    const restored = harness({ state: h.checkpoints.cuts[index], checkpoints: h.checkpoints.prefix(index), ...changed });
    try {
      await assert.rejects(restored.runner.resume(root), /catalog or budgets changed/);
      assert.equal(restored.requests.length, 0);
    } finally {
      await restored.close();
    }
  });
test('production recovery rejects unknown dispatch and tools with no durable child checkpoint', async () => {
  const h = harness();
  await h.runner.run(h.input());
  await h.close();
  const root = h.checkpoints.writes[0].image.frame.owner.contextId;
  for (const point of ['model-waiting', 'tools']) {
    const index = h.checkpoints.writes.findIndex(({ image }) => image?.contract.key === 'conversation.tools.loop' && image.point === point && (point === 'model-waiting' || image.state.active));
    const restored = harness({ state: h.checkpoints.cuts[index], checkpoints: h.checkpoints.prefix(index), nextModel: () => assert.fail('unknown work cannot be resent') });
    try {
      await assert.rejects(restored.runner.resume(root), /no durable continuation/);
      assert.equal(restored.requests.length, 0);
    } finally {
      await restored.close();
    }
  }
});
test('production Group tool restoration preserves accepted mapping without rerunning it', async () => {
  let mapped = 0;
  const mapping = {
    succeeded(value) {
      mapped++;
      return result('error', value);
    },
  };
  const h = harness({ group: true, mapping, nextModel: oneCall() });
  await h.runner.run(h.input());
  await h.close();
  assert.equal(mapped, 1);
  const index = h.checkpoints.writes.findIndex(({ image }) => image?.contract.key === 'conversation.tools.loop' && image.point === 'tools' && image.state.cursor === 1);
  const root = h.checkpoints.writes[0].image.frame.owner.contextId;
  const original = h.exchanges.snapshot().entries[0].feedback;
  mapped = 0;
  const restored = harness({ state: h.checkpoints.cuts[index], checkpoints: h.checkpoints.prefix(index), group: true, mapping, nextModel: oneCall() });
  try {
    assert.equal(await restored.runner.resume(root), 'done');
    assert.equal(mapped, 0);
    assert.equal(restored.source.reads, 1);
    assert.deepEqual(restored.exchanges.snapshot().entries[0].feedback, original);
  } finally {
    await restored.close();
  }
});
for (const change of ['reply', 'feedback', 'provenance'])
  test(`production restore authenticates ${change} against accepted CP facts`, async () => {
    const h = harness();
    await h.runner.run(h.input());
    await h.close();
    const index = h.checkpoints.writes.findIndex(({ image }) => image?.contract.key === 'conversation.tools.loop' && image.point === 'completed');
    const root = h.checkpoints.writes[0].image.frame.owner.contextId;
    const state = copy(h.checkpoints.cuts[index]);
    if (change === 'reply') state.exchanges.entries.at(-1).reply.output[0].text = 'forged';
    if (change === 'feedback') state.exchanges.entries[0].feedback[0].content[0].text = 'forged';
    if (change === 'provenance') state.exchanges.entries[0].operation.childContextId = 'forged';
    const restored = harness({ state, checkpoints: h.checkpoints.prefix(index) });
    try {
      await assert.rejects(restored.runner.resume(root), /differs/);
      assert.equal(restored.requests.length, 0);
    } finally {
      await restored.close();
    }
  });
test('model budget is finite and an incomplete reply cannot dispatch tools', async () => {
  const h = harness({ maxModelCalls: 1 });
  try {
    await assert.rejects(h.runner.run(h.input()), /budget exhausted/);
    assert.equal(h.requests.length, 1);
  } finally {
    await h.close();
  }
  const partial = harness({ nextModel: () => requireModelReply({ ...reply([call('read', 'read', { path: 'notes' })], 'tool_calls'), termination: { kind: 'incomplete', reason: 'length' } }) });
  try {
    await assert.rejects(partial.runner.run(partial.input()), /Incomplete/);
    assert.equal(partial.source.reads, 0);
  } finally {
    await partial.close();
  }
});
test('tool mode never mixes intermediate reasoning text into the final answer output', async () => {
  const h = harness({ nextModel: (request) => (request.exchanges.length ? final('final answer') : reply([{ kind: 'text', text: 'candidate with tool call' }, call('read', 'read', { path: 'notes' })], 'tool_calls')) });
  const output = [];
  h.runner.output.subscribe({
    receive(event) {
      output.push(event);
    },
  });
  try {
    assert.equal(await h.runner.run(h.input()), 'final answer');
    assert.equal(
      output.some((event) => event.kind === 'delta'),
      false,
    );
  } finally {
    await h.close();
  }
});

for (const variant of ['exact', 'different-request', 'missing-feedback', 'different-contract'])
  test(`established model recovery requires exact durable interaction: ${variant}`, async () => {
    const h = harness();
    await h.runner.run(h.input('saved original'));
    await h.close();
    const index = h.checkpoints.writes.findIndex(({ image }) => image?.contract.key === 'conversation.tools.completion' && image.point === 'established');
    const root = h.checkpoints.writes[0].image.frame.owner.contextId;
    const state = copy(h.checkpoints.cuts[index]);
    // The initial established CP precedes the async feedback commit. Retain the
    // actually persisted first interaction feedback, without including later exchanges.
    const id = state.interactions[0].id;
    state.interactions[0] = copy(h.persisted.get(id));
    if (variant === 'different-request') state.interactions[0].request.messages[0].content = 'other material';
    if (variant === 'missing-feedback') delete state.interactions[0].feedback;
    if (variant === 'different-contract') state.interactions[0].contract = 'other.contract';
    const restored = harness({ state, checkpoints: h.checkpoints.prefix(index) });
    try {
      if (variant === 'exact') {
        assert.equal(await restored.runner.resume(root), 'done');
        assert.equal(restored.requests.length, 1);
        assert.equal(restored.requests[0].messages[0].content, 'saved original');
      } else {
        await assert.rejects(restored.runner.resume(root), (error) => error.name === 'ResourcePortError' && error.cause?.code === 'CHECKPOINT_CONTENT_CHANGED');
        assert.equal(restored.requests.length, 0);
      }
    } finally {
      await restored.close();
    }
  });

test('protected recovery evidence failure cannot be converted to ordinary fallback by a parent receiver', async () => {
  const h = harness();
  await h.runner.run(h.input());
  await h.close();
  const index = h.checkpoints.writes.findIndex(({ image }) => image?.contract.key === 'conversation.tools.completion' && image.point === 'established');
  const state = copy(h.checkpoints.cuts[index]);
  let handled = 0;
  const restored = harness({
    state,
    checkpoints: h.checkpoints.prefix(index),
    receiveFailure() {
      handled++;
      return 'fallback';
    },
  });
  try {
    await assert.rejects(restored.runner.resume(h.checkpoints.writes[0].image.frame.owner.contextId), { name: 'ResourcePortError' });
    assert.equal(handled, 0);
    assert.equal(restored.requests.length, 0);
  } finally {
    await restored.close();
  }
});

test('local timeout and cancellation never resend or cancel the independent model send', async () => {
  for (const action of ['timeout', 'cancel']) {
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    const h = harness({
      waitMs: action === 'timeout' ? 1 : 1000,
      nextModel() {
        started.resolve();
        return gate.promise;
      },
    });
    const running = h.runner.run(h.input());
    const failure = assert.rejects(running, action === 'timeout' ? { name: 'ModelReplyPending' } : undefined);
    try {
      await started.promise;
      if (action === 'cancel') h.runner.cancel(new Error('stop locally'));
      await failure;
      assert.equal(h.requests.length, 1);
      assert.equal(h.exchanges.snapshot().entries.length, 0);
      gate.resolve(final('late reply'));
      await h.interactions.settled();
      assert.equal([...h.persisted.values()][0].feedback.payload.output[0].text, 'late reply');
      await assert.rejects(h.runner.resume(h.checkpoints.writes[0].image.frame.owner.contextId));
      assert.equal(h.requests.length, 1);
    } finally {
      gate.resolve(final('late reply'));
      await h.close();
    }
  }
});
