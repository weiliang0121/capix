import assert from 'node:assert/strict';
import { RequestModel } from '@capix/observer-service/conversation';
import { createMaterialConversationScene } from '@capix/conversation-service/assembly';
import { defaultConversationOutputBudget } from '@capix/conversation-service';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';
import { PointFacts } from './point-facts.mjs';

const clone = (value) => structuredClone(value);
const contractName = (definition) => `${definition.checkpoint.key}@${definition.checkpoint.version}`;

/** All declarations come from public service exports. We do not invoke their
 * resources, providers, resume callbacks, host qualification or side effects. */
function fixtureFor(definition, input) {
  const definitions = [...definition.members];
  const points = new Map(definition.checkpoint.points.map((point) => [point.name, point]));
  const records = [];
  const byId = new Map();
  const stages = [];
  let events = [];
  // Decode through the actual service contract before making fixture material.
  const fixedInput = definition.checkpoint.input.decode(definition.checkpoint.input.encode(input));

  function create(id, target, value, key) {
    const position = definitions.indexOf(target);
    assert.ok(position >= 0, 'Fixture child must be an actual direct member');
    assert.ok(!byId.has(id), 'Fixture child already exists');
    const record = { id, position, input: clone(value), key, order: records.length, returned: undefined, reception: { status: 'pending' } };
    records.push(record);
    byId.set(id, record);
    events.push({ kind: 'create', record: clone(record) });
  }

  function accept(id, output, value = output) {
    const record = byId.get(id);
    assert.ok(record && !record.returned);
    record.returned = { status: 'succeeded', output: clone(output) };
    record.reception = { status: 'accepted', value: clone(value) };
    events.push({ kind: 'accept', id, output: clone(output), value: clone(value) });
  }

  function save(name, state, refs) {
    const point = points.get(name);
    assert.ok(point, 'Fixture must use an actual declared point');
    const decoded = point.state.decode(point.state.encode(state));
    stages.push({ name, state: clone(decoded), refs: clone(refs), records: clone(records), events });
    events = [];
  }

  function facts(stage) {
    // This eager oracle is fixture setup only. The experimental hot path reads
    // its existing call directly and never constructs this second material.
    const factsById = new Map();
    const recordByRef = new WeakMap();
    for (const record of stage.records) {
      const ref = Object.freeze({});
      const value = Object.freeze({ ref, ...(record.key === undefined ? {} : { key: record.key }), parentRound: 1, order: record.order, input: record.input, returned: record.returned, reception: record.reception });
      factsById.set(record.id, value);
      recordByRef.set(ref, record);
    }
    const get = (ref) => {
      const record = recordByRef.get(ref);
      assert.ok(record, 'Unknown oracle reference');
      return factsById.get(record.id);
    };
    const selected = (id) => {
      const fact = factsById.get(id);
      assert.ok(fact, 'Unknown selected oracle child');
      return fact;
    };
    const list = (target, query) => stage.records.filter((record) => definitions[record.position] === target && (query?.parentRound === undefined || query.parentRound === 1)).map((record) => selected(record.id));
    const children = {
      get,
      require(target, ref) {
        const fact = get(ref);
        assert.equal(definitions[recordByRef.get(ref).position], target, 'Wrong oracle declaration');
        return fact;
      },
      values: () => [...factsById.values()],
      list,
      requireUnique(target, query) {
        const found = list(target, query);
        assert.equal(found.length, 1, 'Expected one oracle child');
        return found[0];
      },
      accepted(ref, reception) {
        const fact = children.require(reception.child, ref);
        assert.ok(definition.checkpoint.receptions?.includes(reception), 'Unknown oracle reception');
        assert.equal(fact.reception.status, 'accepted');
        reception.value.check(fact.reception.value);
        return fact.reception.value;
      },
    };
    return { input: fixedInput, initialInput: fixedInput, round: 1, children, references: Object.fromEntries(Object.entries(stage.refs).map(([alias, value]) => [alias, Array.isArray(value) ? value.map(selected) : selected(value)])) };
  }

  return {
    definition,
    definitions,
    points,
    input: fixedInput,
    stages,
    create,
    accept,
    save,
    facts,
    check: (stage) => points.get(stage.name).check?.(stage.state, facts(stage)),
  };
}

export function createRequestPointFixture({ direct = false } = {}) {
  const definition = new RequestModel('answer');
  const input = { model: 'fixture', messages: [{ role: 'user', content: 'fixed input' }], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 256, stream: false };
  const output = { id: 'fixture-output', model: 'fixture', content: 'complete provider feedback', finishReason: 'stop', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } };
  const fixture = fixtureFor(definition, input);
  fixture.create('start', definition.invokeModel, input, 'start');
  fixture.save('startWaiting', {}, { start: 'start' });
  const interaction = { id: 'fixture-interaction' };
  if (direct) {
    fixture.accept('start', { kind: 'received', interaction, output });
    fixture.save('feedbackAccepted', output, { start: 'start', follow: [] });
  } else {
    fixture.accept('start', { kind: 'pending', interaction });
    fixture.create('follow', definition.followModel, { ...interaction, expected: { request: input, purpose: 'answer' } }, 'follow');
    fixture.save('followWaiting', {}, { start: 'start', follow: 'follow' });
    fixture.accept('follow', output);
    fixture.save('feedbackAccepted', output, { start: 'start', follow: ['follow'] });
  }
  return fixture;
}

const acceptedInput = () => ({ transcriptId: 'fixture-transcript', index: 0, message: { role: 'user', content: 'hello' } });

export function createContentPointFixture() {
  const scene = createMaterialConversationScene();
  const definition = scene.members.find((member) => member.name === 'maintain-conversation-content');
  const include = definition.members.find((member) => member.name === 'include-conversation-message');
  const remember = definition.members.find((member) => member.name === 'maintain-conversation-memories');
  const input = acceptedInput();
  const fixture = fixtureFor(definition, input);
  fixture.create('include', include, input, 'include');
  fixture.save('messageWaiting', undefined, { include: 'include' });
  fixture.accept('include', undefined);
  fixture.save('messageIncluded', undefined, {});
  fixture.create('remember', remember, input, 'remember');
  fixture.save('memoryWaiting', undefined, { remember: 'remember' });
  fixture.accept('remember', undefined);
  fixture.save('completed', undefined, {});
  return fixture;
}

export function createScenePointFixture() {
  const definition = createMaterialConversationScene();
  const prepare = definition.members.find((member) => member.name === 'prepare-conversation-materials');
  const answer = definition.members.find((member) => member.name === 'answer-from-materials');
  const maintain = definition.members.find((member) => member.name === 'maintain-conversation-content');
  const accepted = acceptedInput();
  const basis = { configuration: 'fixture-config', accepted, transcript: { revision: 1, end: 1, starts: [0], digest: 'fixture-digest' }, memories: { id: 'fixture-memories', transcriptId: accepted.transcriptId, sequence: 0, items: [] }, view: { revision: 0, sources: { messages: { id: accepted.transcriptId, scope: 'fixture-messages' }, memories: { id: 'fixture-memories', scope: 'fixture-memories' } }, members: [] } };
  const input = { query: { transcriptId: accepted.transcriptId, index: 0, content: accepted.message.content }, materials: { basis: { viewRevision: 0, sources: { messages: { ...basis.view.sources.messages, version: 'v1' }, memories: { ...basis.view.sources.memories, version: 'v1' } } }, entries: [] } };
  const response = { transcriptId: accepted.transcriptId, index: 1, message: { role: 'assistant', content: 'world' } };
  const state = { outputBudget: defaultConversationOutputBudget, basis };
  const fixture = fixtureFor(definition, accepted.message.content);
  fixture.create('before', maintain, accepted, 'before');
  fixture.save('beforeWaiting', state, { child: 'before' });
  fixture.accept('before', undefined);
  fixture.create('prepare', prepare, accepted, 'prepare');
  fixture.save('prepareWaiting', state, { child: 'prepare' });
  fixture.accept('prepare', input);
  fixture.create('answer', answer, input, 'answer');
  fixture.save('answerWaiting', { ...state, input }, { child: 'answer' });
  fixture.accept('answer', 'world', response);
  fixture.save('answerAccepted', { ...state, response }, { child: 'answer' });
  fixture.create('after', maintain, response, 'after');
  fixture.save('afterWaiting', { ...state, response }, { child: 'after' });
  fixture.accept('after', undefined);
  fixture.save('completed', { ...state, response }, { child: 'after' });
  return fixture;
}

/** Adapt only declarations and fact ownership. This is not the production
 * binder: it does not promise provider/CP compatibility or host recovery. */
export function createPointPolicyProbe(fixture) {
  const store = new FactStore();
  const contracts = fixture.definitions.map((definition, position) => {
    const reception = fixture.definition.checkpoint.receptions?.find((candidate) => candidate.child === definition);
    return { key: `${fixture.definition.checkpoint.key}.fixture-reception.${position}`, version: fixture.definition.checkpoint.version, childPosition: String(position), check: reception ? reception.value.check.bind(reception.value) : () => {}, codec: reception ? { encode: reception.value.encode.bind(reception.value), decode: reception.value.decode.bind(reception.value) } : { encode: (value) => value, decode: (value) => value } };
  });
  const owner = identity(`point-policy:${fixture.definition.checkpoint.key}`, null, 'root', 0, contractName(fixture.definition));
  const call = new ReceptionEvidenceCall(store, owner, fixture.input, { contracts });
  const sources = {};
  const points = fixture.definition.checkpoint.points.map((point) => ({
    name: point.name,
    version: fixture.definition.checkpoint.version,
    slots: Object.fromEntries(
      Object.entries(point.references).map(([alias, slot]) => {
        const position = fixture.definitions.indexOf(slot.definition);
        assert.ok(position >= 0, 'Public point references an unregistered member');
        const source = `${position}:${slot.many ? 'many' : 'one'}`;
        // Sharing this source between points is an explicit fixture choice.
        // A one and many projection never implicitly convert one another.
        sources[source] = { cardinality: slot.many ? 'many' : 'one', definition: slot.definition };
        return [alias, source];
      }),
    ),
    check: point.check,
  }));
  const configuration = {
    definitions: fixture.definitions.map((definition, position) => ({ definition, position: String(position), contract: contractName(definition) })),
    sources,
    points,
    receptions: (fixture.definition.checkpoint.receptions ?? []).map((reception) => ({ reception, contract: contracts[fixture.definitions.indexOf(reception.child)] })),
    orderOffset: -1,
  };
  const facts = new PointFacts(call, configuration);
  const pointByName = new Map(points.map((point) => [point.name, point]));
  const identities = new Map();

  function apply(events) {
    for (const event of events) {
      if (event.kind === 'create') {
        const record = event.record;
        const child = call.createChild(record.id, record.input, { position: String(record.position), contract: contractName(fixture.definitions[record.position]), key: record.key });
        assert.equal(child.order - 1, record.order, 'Explicit view offset preserves production creation order');
        identities.set(record.id, child);
      } else {
        assert.equal(event.kind, 'accept');
        const child = identities.get(event.id);
        assert.ok(child, 'Unknown fixture child');
        call.returned(child, event.output);
        call.establish(child, 'accepted', event.value, contracts[Number(child.position)]);
      }
    }
  }

  function select(pointName, refs) {
    const point = pointByName.get(pointName);
    assert.ok(point, 'Unknown fixture point');
    assert.deepEqual(Object.keys(refs).sort(), Object.keys(point.slots).sort(), 'Fixture must explicitly select exactly the current point roles');
    for (const [alias, value] of Object.entries(refs)) {
      const source = point.slots[alias];
      if (sources[source].cardinality === 'many') {
        assert.ok(Array.isArray(value));
        for (const occurrence of call.referenceEntries(source)) call.removeReference(source, occurrence.id);
        for (const id of value) {
          const child = identities.get(id);
          assert.ok(child, 'Unknown fixture selection');
          call.addReference(source, child);
        }
      } else {
        assert.equal(typeof value, 'string');
        const child = identities.get(value);
        assert.ok(child, 'Unknown fixture selection');
        call.reference(source, child);
      }
    }
  }

  return {
    call,
    facts,
    store,
    owner,
    contracts,
    configuration,
    points: pointByName,
    child: (id) => identities.get(id),
    apply,
    select,
    save(stage) {
      apply(stage.events);
      select(stage.name, stage.refs);
      return facts.save(pointByName.get(stage.name), stage.state);
    },
    reopen() {
      const restored = ReceptionEvidenceCall.reopen(store, owner, { contracts });
      const queries = new PointFacts(restored, configuration);
      return { call: restored, facts: queries };
    },
    close: () => store.close(),
  };
}
