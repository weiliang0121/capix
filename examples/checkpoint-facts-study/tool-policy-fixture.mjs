import assert from 'node:assert/strict';
import { z } from 'zod';
import { Node } from '@capix/structure';
import { ToolLoop, tool } from '@capix/conversation-service/tools';
import { ModelExchanges, feedbackDigest } from '@capix/model-exchanges';
import { requireModelReply } from '@capix/model-provider';
import { RuntimeErrorHelper } from '@capix/diagnostics';

const clone = (value) => structuredClone(value);
const codec = { encode: clone, decode: clone };
const result = (text, status = 'ok') => ({ status, content: [{ kind: 'text', text }] });
const call = (id, name = 'read') => ({ kind: 'tool-call', id, name, arguments: { encoding: 'json-text', text: JSON.stringify({ path: 'same.txt' }) } });

function reply(id, calls) {
  return requireModelReply({ formatVersion: 1, id, model: 'offline-policy-fixture', output: calls ?? [{ kind: 'text', text: 'done' }], termination: { kind: 'completed', reason: calls ? 'tool_calls' : 'stop' }, usage: null, native: { format: 'chat-completions', version: 1 } });
}

/**
 * A public production policy oracle, not a Runner or recovery implementation.
 * Checkpoint callbacks come from the real ToolLoop declaration. Plain reference
 * tokens below stand in for already-authenticated ChildFacts; they do not grant
 * invocation authority. ModelExchanges itself supplies all entity validation.
 */
export function createToolPolicyFixture(options = {}) {
  const read = new Node({
    name: 'policy-fixture-read',
    checkpoint: { key: 'study.tool-policy.read', version: 1, input: codec, output: codec, points: [] },
    run() {
      throw new Error('Policy fixture must not execute tools');
    },
  });
  const loop = new ToolLoop({
    policyVersion: 'study.tool-policy@1',
    checkpoint: true,
    maxModelCalls: 8,
    budgets: options.budgets,
    tools: { read: tool(read, { description: 'Read a fixed fixture value.', input: z.strictObject({ path: z.string() }), maxOutputBytes: options.maxOutputBytes, result: { succeeded: (value) => result(value.text), failed: () => result('handled', 'error') } }) },
  });
  const points = new Map(loop.checkpoint.points.map((point) => [point.name, point]));
  const model = points.get('tools').references.models.definition;
  const definitions = { model, read };
  const definitionAt = [model, read];
  const receptions = new Map(loop.checkpoint.receptions.map((reception) => [reception.child, reception]));
  const parentId = 'policy-fixture-parent';
  const scope = 'policy-fixture-scope';
  const entity = new ModelExchanges();
  const input = loop.input({ messages: [{ role: 'user', content: 'Read the fixture.' }], maxTokens: 128 }, scope, entity.id);
  const snapshots = new Map();
  const records = [];
  const refs = { models: [], read: [] };
  let state = { exchanges: [], current: null, cursor: 0, active: null };
  const operation = (record, position) => ({ parentContextId: parentId, childContextId: record.identity.contextId, position });

  function add(slot, contextId, childInput, key) {
    const position = slot === 'models' ? 0 : 1;
    const definition = definitionAt[position];
    const order = records.length;
    const record = { identity: { contextId, parentId, position, contract: { key: definition.checkpoint.key, version: definition.checkpoint.version }, order }, ref: { contextId }, key, input: clone(childInput), returned: undefined, reception: { status: 'pending' }, parentRound: 1, order };
    records.push(record);
    refs[slot].push(record.ref);
    return record;
  }
  function save(name, point = 'tools') {
    const snapshot = clone({ name, point, parentId, input, state, refs, records, exchanges: entity.snapshot() });
    snapshots.set(name, snapshot);
    return snapshot;
  }
  function intake(record, value) {
    record.returned = { status: 'succeeded', output: value };
    const provenance = operation(record, 'model-reply');
    const reference = entity.intake(scope, provenance, value);
    record.reception = { status: 'accepted', value: { reference, operation: provenance } };
    state = { ...state, current: reference, cursor: 0, active: null };
  }
  function receive(record, callId, failed = false) {
    record.returned = failed ? { status: 'failed', diagnostic: RuntimeErrorHelper.format(new Error('fixture tool exception')) } : { status: 'succeeded', output: { text: 'read-value' } };
    const provenance = operation(record, 'tool-feedback');
    const feedback = result(failed ? 'handled' : 'read-value', failed ? 'error' : 'ok');
    const reference = entity.complete(scope, state.current, callId, feedback, provenance);
    const saved = entity.read(scope, reference).feedback.find((item) => item.toolCallId === callId);
    record.reception = { status: failed ? 'handled' : 'accepted', value: { reference, operation: provenance, feedbackDigest: feedbackDigest(saved) } };
    state = { ...state, current: reference, cursor: state.cursor + 1, active: null };
  }
  function waitingTool(contextId, callId) {
    const record = add('read', contextId, { path: 'same.txt' }, callId);
    state = { ...state, active: { name: 'read', index: refs.read.length - 1, callId } };
    return record;
  }
  function nextModel(contextId) {
    state = { exchanges: [...state.exchanges, state.current], current: null, cursor: 0, active: null };
    entity.closed(scope, state.exchanges);
    return add('models', contextId, { exchanges: state.exchanges }, `model:${refs.models.length}`);
  }

  const first = add('models', 'model-0', { exchanges: [] }, 'model:0');
  save('waiting-model', 'model-waiting');
  intake(first, reply('reply-0', [call('reused'), call('rejected', 'unknown'), call('handled')]));
  save('received-model');
  const accepted = waitingTool('tool-0', 'reused');
  save('waiting-tool');
  receive(accepted, 'reused');
  save('accepted-tool');
  const rejection = loop.checkToolCall(call('rejected', 'unknown'));
  assert.equal(rejection.kind, 'rejected');
  state = { ...state, current: entity.complete(scope, state.current, 'rejected', rejection.result), cursor: state.cursor + 1 };
  save('rejected-precheck');
  const handled = waitingTool('tool-1', 'handled');
  save('waiting-handled-tool');
  receive(handled, 'handled', true);
  save('handled-tool');
  const second = nextModel('model-1');
  save('next-model-waiting', 'model-waiting');
  intake(second, reply('reply-1', [call('reused')]));
  save('second-received-model');
  const repeated = waitingTool('tool-2', 'reused');
  save('repeated-key-waiting-tool');
  receive(repeated, 'reused');
  save('repeated-key-accepted-tool');
  const final = nextModel('model-2');
  save('final-model-waiting', 'model-waiting');
  intake(final, reply('reply-2'));
  save('final', 'completed');

  function facts(snapshot) {
    const byId = new Map();
    for (const record of snapshot.records) {
      if (byId.has(record.identity.contextId)) throw new Error('Duplicate fixture child identity');
      byId.set(record.identity.contextId, record);
    }
    const get = (reference) => {
      const record = byId.get(reference?.contextId);
      if (!record) throw new Error('Unknown fixture child reference');
      return record;
    };
    const definitionOf = (record) => {
      if (record.identity.parentId !== snapshot.parentId) throw new Error('Foreign fixture child owner');
      const definition = definitionAt[record.identity.position];
      if (!definition) throw new Error('Unknown fixture declaration position');
      return definition;
    };
    const receiveValue = (status, reference, reception) => {
      const record = get(reference);
      if (record.reception.status !== status || receptions.get(definitionOf(record)) !== reception) throw new Error(`Child has no ${status} value under this reception contract`);
      return reception.value.check(record.reception.value);
    };
    const children = {
      get,
      require(definition, reference) {
        const record = get(reference);
        if (definitionOf(record) !== definition) throw new Error('Child reference belongs to a different declaration');
        return record;
      },
      accepted: (reference, reception) => receiveValue('accepted', reference, reception),
      handled: (reference, reception) => receiveValue('handled', reference, reception),
      values: () => snapshot.records.slice(),
      list: (definition, query) => snapshot.records.filter((record) => definitionOf(record) === definition && (query?.parentRound === undefined || query.parentRound === record.parentRound)),
    };
    children.requireUnique = (definition, query) => {
      const matches = children.list(definition, query);
      if (matches.length !== 1) throw new Error('Expected exactly one direct child fact');
      return matches[0];
    };
    return { initialInput: snapshot.input, input: snapshot.input, round: 1, references: Object.fromEntries(Object.entries(snapshot.refs).map(([slot, references]) => [slot, references.map(get)])), children };
  }
  function productionCheck(snapshot, pointName = snapshot.point) {
    const point = points.get(pointName);
    if (!point) throw new Error('Unknown ToolLoop checkpoint point');
    // Deliberately preserve the original exception: no boolean or diagnostic wrapper.
    return point.check(snapshot.state, facts(snapshot));
  }
  const restoreExchanges = (snapshot) => ModelExchanges.restore(snapshot.exchanges);
  function productionConfirm(snapshot, options = {}) {
    const exchanges = restoreExchanges(snapshot);
    const resource = options.exchanges ?? { read: (reference) => exchanges.read(snapshot.input.scope, reference, false), closed: (references) => exchanges.closed(snapshot.input.scope, references) };
    const work = { input: snapshot.input, resources: { exchanges: resource }, children: { facts: facts(snapshot).children } };
    // completed.resume calls the real confirmExchanges and finalText closures.
    // This checks policy + durable entity compatibility, not host eligibility.
    return points.get('completed').resume.run(work, snapshot.state, snapshot.refs);
  }
  return { loop, definitions, points, snapshots, snapshot: (name) => clone(snapshots.get(name) ?? assert.fail(`Unknown fixture snapshot: ${name}`)), facts, restoreExchanges, productionCheck, productionConfirm };
}
