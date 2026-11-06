import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual as equal } from 'node:util';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Interaction } from '@capix/interaction';
import { CompletionResource, CompletionInteraction, CompletionInteractionResource } from '@capix/conversation-service';
import { createConversationInteractions, loadConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { createRecoveryScene, analysisRequest } from './structure.mjs';

const [mode, database, variant = 'accepted', fault = 'none'] = process.argv.slice(2);
if (!['capture', 'resume', 'inspect'].includes(mode) || !database || !['accepted', 'handled'].includes(variant) || !['none', 'missing-checkpoint', 'missing-feedback', 'wrong-feedback-request'].includes(fault)) throw new Error('Usage: host.mjs capture|resume|inspect DATABASE [accepted|handled] [none|missing-checkpoint|missing-feedback|wrong-feedback-request]');

// The fixture owns the SQLite file and two gated offline requests. These gates
// choose a reproducible crash boundary; no business continuation reads them.
const store = ConversationStore.open(database);
const content = loadConversationContent(store);
const counters = { primaryRuns: 0, primaryAccepted: 0, primaryHandled: 0, secondaryAccepted: 0, mergeAccepted: 0, primaryRequests: 0, secondaryRequests: 0, mergeRequests: 0 };
const eventNames = { 'primary.run': 'primaryRuns', 'primary.accept': 'primaryAccepted', 'primary.handle': 'primaryHandled', 'secondary.accept': 'secondaryAccepted', 'merge.accept': 'mergeAccepted' };
const gates = new Map();
const preview = [];
const recoveryFacts = [];
let readerSaved = false;
let partialSaved = false;
let runner;
let interactions;
let before;
let resumeEntered = false;

function inputOf(request) {
  return JSON.parse(request.messages.find((message) => message.role === 'user').content);
}

function root() {
  return store.checkpoints.listRoots().findLast((head) => head.image.contract.key === 'example.parallel-recovery');
}

function child(head, key) {
  return head?.image.frame.children.find((entry) => entry.key === key);
}

function evidence() {
  const head = root();
  const secondary = child(head, 'secondary');
  const branch = secondary ? store.checkpoints.read(secondary.identity.contextId) : undefined;
  const read = child(branch, 'read');
  const reader = read ? store.checkpoints.read(read.identity.contextId) : undefined;
  const reference = read?.input;
  return { root: head, branch, reader, reference, interaction: reference ? store.interactions.read(reference.id) : undefined };
}

function report(result, error) {
  return { pid: process.pid, mode, variant, fault, counters, preview, recoveryFacts, resumeEntered, before, ...evidence(), ...(result !== undefined ? { result } : {}), ...(error ? { error: { name: error.name, code: error.code, message: error.message } } : {}) };
}

function output(value) {
  // Synchronous stdout avoids losing the report when the crash exits immediately.
  writeFileSync(1, JSON.stringify(value));
}

function release() {
  if (readerSaved) gates.get(0)?.resolve();
  if (partialSaved) gates.get(2)?.resolve();
}

const model = {
  async complete(request, controls = {}) {
    const input = inputOf(request);
    if (input.stage === 'merge') {
      counters.mergeRequests++;
      assert.equal(input.primary.material.index, 0);
      assert.equal(input.secondary.material.index, 2);
      const text = input.primary.status === 'unavailable' ? 'A 分析不可用；B 保留测试时间。' : 'A 发布更早；B 保留测试时间。';
      controls.emit?.(text);
      return { id: 'merge-offline', model: 'offline-parallel-recovery', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
    }
    assert.equal(input.stage, 'analysis');
    const index = input.material.index;
    assert.ok(index === 0 || index === 2);
    counters[index === 0 ? 'primaryRequests' : 'secondaryRequests']++;
    if (mode !== 'capture') throw new Error('Recovery must never resend an analysis request');
    assert.equal(gates.has(index), false, 'each analysis is sent once');
    const gate = Promise.withResolvers();
    gates.set(index, gate);
    release();
    await gate.promise;
    controls.emit?.(`内部分析 ${index}`);
    return { id: `analysis-${index}`, model: 'offline-parallel-recovery', formatVersion: 1, output: [{ kind: 'text', text: index === 0 ? 'A 发布更早。' : 'B 保留测试时间。' }], native: { format: 'chat-completions', version: 1 }, termination: { kind: index === 0 && variant === 'handled' ? 'incomplete' : 'completed', reason: index === 0 && variant === 'handled' ? 'length' : 'stop' }, usage: null };
  },
};

// Fault injection hides the exact missing evidence through public read ports;
// it neither alters SQLite rows nor substitutes a fabricated successful result.
const checkpointPort = {
  read(id) {
    if (fault === 'missing-checkpoint' && id === before?.reader?.image.frame.owner.contextId) return undefined;
    return store.checkpoints.read(id);
  },
  finish: (...args) => store.checkpoints.finish(...args),
  save(image, revision) {
    const receipt = store.checkpoints.save(image, revision);
    if (mode === 'capture' && image.contract.key === 'conversation.completion-reply' && image.point === 'waiting') {
      const state = store.interactions.read(image.frame.input.id);
      if (state && inputOf(state.request).material?.index === 2) readerSaved = true;
    }
    if (mode === 'capture' && image.contract.key === 'example.parallel-recovery' && image.point === 'analyses') {
      const primary = image.frame.children.find((entry) => entry.key === 'primary');
      const secondary = image.frame.children.find((entry) => entry.key === 'secondary');
      if (['accepted', 'handled'].includes(primary?.state.reception?.kind) && secondary?.state.kind === 'waiting') partialSaved = true;
    }
    release();
    return receipt;
  },
};
const interactionPort = {
  create: (state) => store.interactions.create(state),
  read(id) {
    const state = store.interactions.read(id);
    if (fault === 'missing-feedback' && id === before?.reference?.id && state) {
      const { feedback, ...withoutFeedback } = state;
      return withoutFeedback;
    }
    if (fault === 'wrong-feedback-request' && id === before?.reference?.id && state) return { ...state, request: analysisRequest(before.root.image.frame.input.query, before.root.image.frame.input.primary) };
    return state;
  },
  commit(change) {
    store.interactions.commit(change);
    if (mode === 'capture' && change.state.feedback && inputOf(change.state.request).material?.index === 2) {
      assert.ok(readerSaved && partialSaved);
      assert.equal(counters.primaryRequests, 1);
      assert.equal(counters.secondaryRequests, 1);
      output(report());
      // Real process loss after feedback commit, before the waiting reader can
      // consume it: no cancellation, thrown exception or fake checkpoint image.
      process.exit(73);
    }
  },
};

function requireEvidence(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'EXAMPLE_RECOVERY_UNAVAILABLE' });
}

function linkedHead(port, relation, parentId, contract, point) {
  requireEvidence(relation?.identity.parentContextId === parentId, 'Child ownership changed');
  const head = port.read(relation.identity.contextId);
  requireEvidence(head && !head.delivery && head.image.contract.key === contract && head.image.contract.version === (contract.startsWith('conversation.completion') || contract === 'conversation.interaction-completion' ? 2 : 1) && head.image.point === point, 'Required waiting child checkpoint is unavailable');
  requireEvidence(equal(head.image.frame.owner, relation.identity) && equal(head.image.contract, relation.contract) && equal(head.image.frame.input, relation.input) && head.image.frame.round === 1, 'Child checkpoint differs from its saved relationship');
  return head;
}

// This is deliberately the eligibility check for ONE fixture boundary, not a
// reusable recovery walker and not the default conversation service's contract.
function assertPartialRecovery(head) {
  requireEvidence(head && !head.delivery && head.image.contract.key === 'example.parallel-recovery' && head.image.contract.version === 1 && head.image.point === 'analyses' && head.image.frame.owner.kind === 'scene' && head.image.frame.round === 1, 'This example resumes only its unfinished parallel analyses boundary');
  const input = head.image.frame.input;
  const messages = content.transcript.snapshot();
  for (const selected of [input.query, input.primary, input.secondary]) requireEvidence(selected.transcriptId === content.transcript.id && messages[selected.index]?.content === selected.content, 'Fixed input differs from persisted formal material');
  const primary = child(head, 'primary');
  const secondary = child(head, 'secondary');
  requireEvidence(head.image.frame.children.length === 2 && primary?.order === 0 && secondary?.order === 1 && primary.identity.parentContextId === head.image.frame.owner.contextId, 'Parallel branch positions or ownership changed');
  requireEvidence((primary.state.kind === 'returned' && primary.state.reception.kind === 'accepted') || (primary.state.kind === 'failed' && primary.state.reception?.kind === 'handled'), 'Primary analysis has no settled reception');
  requireEvidence(secondary.state.kind === 'waiting' && equal(secondary.input, analysisRequest(input.query, input.secondary)), 'Secondary waiting request changed');
  const branch = linkedHead(checkpointPort, secondary, head.image.frame.owner.contextId, 'conversation.interaction-completion', 'reading');
  const sent = child(branch, 'send');
  const read = child(branch, 'read');
  requireEvidence(branch.image.frame.children.length === 2 && sent?.order === 0 && sent.identity.parentContextId === secondary.identity.contextId && sent.state.kind === 'returned' && sent.state.reception.kind === 'accepted' && equal(sent.input, secondary.input) && equal(sent.state.output, sent.state.reception.output), 'Secondary send reference was not accepted accurately');
  requireEvidence(read?.order === 1 && read.state.kind === 'waiting' && equal(read.input, sent.state.output), 'Secondary read does not use its accepted send reference');
  const reader = linkedHead(checkpointPort, read, secondary.identity.contextId, 'conversation.completion-reply', 'waiting');
  const reference = read.input;
  requireEvidence(equal(reader.image.state, reference) && reference.contract === CompletionInteraction.key, 'Secondary reader changed its fixed interaction reference');
  const state = interactionPort.read(reference.id);
  requireEvidence(state?.id === reference.id && state.contract === reference.contract && equal(state.request, secondary.input) && state.feedback, 'Original complete secondary feedback is unavailable');
  requireEvidence(Interaction.restore(state, { contract: CompletionInteraction }).read().kind === 'received', 'Secondary interaction is not readable');
}

try {
  before = evidence();
  if (mode === 'inspect') output(report());
  else {
    interactions = createConversationInteractions(model, interactionPort);
    const resources = new Resources().register(new Resource(model), CompletionResource).registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
    const scene = createRecoveryScene({
      report(name) {
        counters[eventNames[name]]++;
      },
    });
    runner = new Runner(scene, resources, interactions, {
      checkpoints: {
        store: checkpointPort,
        observation: {
          observe(fact) {
            recoveryFacts.push({ kind: fact.kind, contextId: fact.contextId, mode: fact.mode, child: fact.child });
          },
        },
      },
    }).build();
    runner.output.subscribe({
      receive(event) {
        if (event.kind === 'delta') preview.push(event.delta);
      },
    });
    let result;
    if (mode === 'capture') {
      requireEvidence(!before.root && content.transcript.length === 0, 'Capture requires a fresh example database');
      for (const message of [
        { role: 'user', content: 'A：周五发布，测试时间紧张。' },
        { role: 'assistant', content: '已收到方案 A。' },
        { role: 'user', content: 'B：下周二发布，测试时间完整。' },
        { role: 'user', content: '比较两个方案。' },
      ])
        content.transcript.append(message);
      const messages = content.transcript.snapshot();
      const selected = (index) => ({ transcriptId: content.transcript.id, index, content: messages[index].content });
      result = await runner.run({ query: selected(3), primary: selected(0), secondary: selected(2) });
      throw new Error(`Capture reached completion instead of the interruption: ${result}`);
    } else {
      assertPartialRecovery(before.root);
      resumeEntered = true;
      result = await runner.resume(before.root.image.frame.owner.contextId);
      await interactions.settled();
      output(report(result));
    }
  }
} catch (error) {
  for (const gate of gates.values()) gate.reject(new Error('Offline fixture is closing'));
  await interactions?.settled();
  output(report(undefined, error));
  process.exitCode = 1;
} finally {
  await interactions?.settled();
  interactions?.close();
  store.close();
}
