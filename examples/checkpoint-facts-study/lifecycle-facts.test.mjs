import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCheckpointSaveReceipt, checkCheckpointFinishReceipt, checkpointReference, cloneCheckpointImage } from '@weiliang0121/capix-checkpoint';
import { FactCall } from './fact-call.mjs';
import { FactStore, identity as carrierIdentity } from './fact-store.mjs';
import { LifecycleFacts } from './lifecycle-facts.mjs';

const contract = { key: 'lifecycle-test', version: 1 };
const owner = { contextId: 'parent', kind: 'group' };
const diagnostic = { code: 'BUSINESS_FAILURE', message: 'Expected fixture failure' };
const reception = { position: 2, childPosition: 0 };

function setup(t, identity = owner, input = { text: 'parent' }) {
  const store = new FactStore();
  t.after(() => store.close());
  return { store, call: new LifecycleFacts(store, { identity, input, contract }) };
}

function child(contextId = 'child', order = 0, input = { text: contextId }, declaration = true) {
  return { identity: { contextId, parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, ...(declaration ? { contract } : {}), round: 1, order, key: 'reusable-role', input };
}

function progress(input = { text: 'child' }) {
  return { round: 1, phase: 'execute', currentInput: input };
}
function request(id = 'cp1', state = {}, references = {}) {
  return { id, formatVersion: 5, contract, point: 'waiting', state, references };
}
function succeeded(output = { text: 'result' }) {
  return { status: 'succeeded', output };
}
function failed(allowed = true) {
  return { status: 'failed', diagnostic, failure: { kind: 'error', phase: 'execute', contextId: 'child', receptionAllowed: allowed } };
}

test('descriptor and ordinary data are fixed independently of checkpoints', (t) => {
  const input = { text: 'before' };
  const { call } = setup(t, owner, input);
  input.text = 'after';
  assert.equal(call.input.text, 'before');
  assert.throws(() => {
    call.input = input;
  }, TypeError);
  const childInput = { text: 'child' };
  call.registerChild(child('child', 0, childInput));
  childInput.text = 'changed';
  assert.equal(call.relation('child').input.text, 'child');
  assert.equal(call.readHead(), undefined);
});

test('only boundary-derived frames may be saved, with the actual checkpoint receipt shape', (t) => {
  const { call } = setup(t);
  call.registerChild(child());
  const receipt = call.checkpoint(request(), 0);
  const head = call.readHead();
  assert.deepEqual(head.image.frame.owner, owner);
  assert.equal(head.image.frame.children[0].state.kind, 'waiting');
  assert.deepEqual(checkCheckpointSaveReceipt(receipt, head.image, 0), receipt);
  assert.throws(() => call.checkpoint({ ...request('cp2'), frame: head.image.frame }, 1), /derived/);
});

test('accurate parent, kind, order, declaration, and child identities are enforced', (t) => {
  const { call } = setup(t);
  assert.throws(() => call.registerChild({ ...child(), identity: { ...child().identity, parentContextId: 'other' } }), /parent/);
  assert.throws(() => call.registerChild({ ...child(), identity: { ...child().identity, kind: 'scene' } }), /kind/);
  assert.throws(() => call.registerChild(child('later', 2)), /order/);
  assert.throws(() => call.registerChild({ ...child(), target: { position: -1 } }), /position/);
  call.registerChild(child());
  assert.throws(() => call.registerChild(child()), /Duplicate/);
  call.registerChild(child('second', 1));
  assert.equal(call.projectFrame().nextChildOrder, 2);
});

test('Node owner cannot register a child', (t) => {
  const { call } = setup(t, { ...owner, kind: 'node' });
  assert.throws(() => call.registerChild(child()), /kind/);
});

test('waiting requires the child checkpoint declaration; a completed plain child does not', (t) => {
  const { call } = setup(t);
  call.registerChild(child('child', 0, {}, false));
  assert.throws(() => call.checkpoint(request(), 0), /Waiting child/);
  call.returned('child', succeeded('plain'), progress({}));
  call.checkpoint(request(), 0);
  assert.equal(call.readHead().image.frame.children[0].state.output, 'plain');
});

test('return and acceptance are independent fixed facts', (t) => {
  const { call } = setup(t);
  call.registerChild(child());
  const output = { value: 1 };
  call.returned('child', succeeded(output), progress());
  output.value = 9;
  call.receiving('child', reception);
  const accepted = { value: 2 };
  call.received('child', 'accepted', accepted);
  accepted.value = 10;
  call.checkpoint(request(), 0);
  const state = call.readHead().image.frame.children[0].state;
  assert.deepEqual(state.output, { value: 1 });
  assert.deepEqual(state.reception, { kind: 'accepted', contract: { position: 2 }, output: { value: 2 } });
});

test('reception ordering and its exact declared target cannot drift', (t) => {
  const { call } = setup(t);
  call.registerChild(child());
  assert.throws(() => call.receiving('child'), /not returned/);
  assert.throws(() => call.received('child', 'accepted', 1), /not started/);
  call.returned('child', succeeded(1), progress());
  assert.throws(() => call.returned('child', succeeded(2), progress()), /already returned/);
  assert.throws(() => call.receiving('child', { position: 2, childPosition: 9 }), /different declaration/);
  call.receiving('child', reception);
  assert.throws(() => call.received('child', 'handled', 2), /disagrees/);
  assert.throws(() => call.received('child', 'accepted', 2, { position: 3, childPosition: 0 }), /changed/);
  call.received('child', 'accepted', 2);
  assert.throws(() => call.receiving('child'), /not pending/);
});

test('a business failure remains failed after a handled replacement is accepted', (t) => {
  const { call } = setup(t);
  call.registerChild(child());
  call.returned('child', failed(), progress());
  assert.throws(() => call.projectFrame(), /unhandled/);
  call.receiving('child', reception);
  call.received('child', 'handled', { replacement: true });
  call.checkpoint(request(), 0);
  const state = call.readHead().image.frame.children[0].state;
  assert.equal(state.kind, 'failed');
  assert.deepEqual(state.error, diagnostic);
  assert.equal(Object.hasOwn(state.failure, 'receptionAllowed'), false);
  assert.deepEqual(state.reception, { kind: 'handled', contract: { position: 2 }, output: { replacement: true } });
});

for (const cancelled of [false, true]) {
  test(`${cancelled ? 'cancelled' : 'protected'} failure cannot be converted into a handled frame`, (t) => {
    const { call } = setup(t);
    call.registerChild(child());
    call.checkpoint(request(), 0);
    call.returned('child', cancelled ? { status: 'cancelled', diagnostic } : failed(false), progress());
    assert.throws(() => call.receiving('child'), /Protected or cancelled/);
    assert.throws(() => call.checkpoint(request('cp2'), 1), /protected/);
    assert.equal(call.readHead().image.frame.children[0].state.kind, 'waiting');
  });
}

test('reception failure has its own diagnostic and is not current-round recovery evidence', (t) => {
  const { call } = setup(t);
  call.registerChild(child());
  call.checkpoint(request(), 0);
  call.returned('child', succeeded('child'), progress());
  call.receiving('child', reception);
  call.receptionFailed('child', { diagnostic: { code: 'MAPPING', message: 'Mapping failed' }, source: 'result.succeeded' });
  assert.equal(call.inspect().relations[0].returned.status, 'succeeded');
  assert.equal(call.inspect().relations[0].reception.status, 'failed');
  assert.throws(() => call.checkpoint(request('cp2'), 1), /reception failure/);
  call.finish({ status: 'failed' }, 1);
  assert.equal(call.readHead().image.frame.children[0].state.kind, 'waiting');
});

test('work terminal, durable delivery, and parent-observed return remain independent', (t) => {
  const { store, call: parent } = setup(t);
  const specification = child();
  parent.registerChild(specification);
  parent.checkpoint(request('parent-cp'), 0);
  const nested = new LifecycleFacts(store, { identity: specification.identity, input: specification.input, contract });
  nested.checkpoint(request('child-cp'), 0);
  nested.workTerminal(succeeded('business-output'));
  assert.equal(nested.durableDelivery, undefined);
  nested.finish({ status: 'succeeded', output: 'business-output', progress: progress() }, 1);
  parent.returned('child', { status: 'failed', diagnostic: { code: 'LOST_RECEIPT', message: 'Parent received failure' }, failure: { kind: 'error', phase: 'control', contextId: 'child', receptionAllowed: false } }, progress());
  assert.equal(nested.work.status, 'succeeded');
  assert.equal(nested.durableDelivery.status, 'succeeded');
  assert.equal(parent.relation('child').returned.status, 'failed');
  assert.throws(() => parent.checkpoint(request('invalid-parent-cp'), 1), /unhandled/);
  assert.equal(parent.readHead().image.frame.children[0].state.kind, 'waiting');
  const coldParent = LifecycleFacts.reopen(store, 'parent');
  assert.equal(coldParent.relation('child').returned, null);
  assert.equal(LifecycleFacts.reopen(store, 'child').durableDelivery.status, 'succeeded');
  parent.workTerminal({ status: 'failed', diagnostic });
  parent.finish({ status: 'failed' }, 1);
  const ended = LifecycleFacts.reopen(store, 'parent');
  assert.equal(ended.work.status, 'failed');
  assert.equal(ended.relation('child').returned.status, 'failed');
  assert.equal(ended.readHead().image.frame.children[0].state.kind, 'waiting');
  assert.equal(ended.durableDelivery.status, 'failed');
  assert.throws(() => ended.checkpoint(request('revive'), 2), /Final lifecycle/);
});

test('finish keeps the previous image and returns the actual finish receipt', (t) => {
  const { store, call } = setup(t);
  call.checkpoint(request(), 0);
  const image = call.readHead().image;
  call.workTerminal(succeeded('done'));
  const delivery = { status: 'succeeded', output: 'done', progress: progress({ text: 'parent' }) };
  const receipt = call.finish(delivery, 1);
  assert.equal(call.readHead().image, image);
  assert.deepEqual(checkCheckpointFinishReceipt(receipt, 'parent', 'cp1', delivery, 1), receipt);
  assert.deepEqual(LifecycleFacts.reopen(store, 'parent').readHead(), call.readHead());
  assert.equal(store.readHead('parent').status, 'active', 'Carrier is not the Invocation lifecycle');
  assert.throws(() => call.workTerminal(succeeded('again')), /Final lifecycle/);
  assert.throws(() => call.finish(delivery, 2), /Final lifecycle/);
});

test('missing first checkpoint never acquires an implicit finish', (t) => {
  const { call } = setup(t);
  call.workTerminal(succeeded('result'));
  assert.throws(() => call.finish({ status: 'succeeded', output: 'result', progress: progress() }, 0), /without a saved/);
  assert.equal(call.durableDelivery, undefined);
});

test('CP reference identity and stable declaration contracts remain authenticated', (t) => {
  const { call } = setup(t);
  call.registerChild(child());
  const reference = checkpointReference(call.projectFrame().children[0]);
  call.checkpoint(request('cp1', { cursor: 0 }, { waiting: reference }), 0);
  assert.throws(() => call.checkpoint(request('cp2', {}, { waiting: { ...reference, order: 1 } }), 1), /reference differs/);
  assert.throws(() => call.checkpoint({ ...request('cp2'), contract: { key: 'changed', version: 1 } }, 1), /contract changed/);
  assert.throws(() => call.checkpoint(request('cp1'), 1), /identity reused/);
});

test('new mechanism neither revives old rounds nor silently accepts live Error values', (t) => {
  const { call } = setup(t);
  assert.throws(() => call.projectFrame({ round: 2, phase: 'execute' }), /first-round/);
  assert.throws(() => call.registerChild({ ...child(), round: 2 }), /first-round/);
  call.registerChild(child());
  assert.throws(() => call.returned('child', { status: 'failed', diagnostic: new Error('live') }, progress()));
  assert.equal(call.relation('child').returned, null);
  assert.throws(() => call.workTerminal(succeeded(new Date())));
  assert.equal(call.work, null);
});

for (const cut of ['facts', 'head', 'committed']) {
  test(`checkpoint cut at ${cut} respects the durable boundary`, (t) => {
    const { store, call } = setup(t);
    call.registerChild(child());
    call.checkpoint(request(), 0);
    call.returned('child', succeeded('new'), progress());
    assert.throws(
      () =>
        call.checkpoint(request('cp2'), 1, {
          fault: (at) => {
            if (at === cut) throw new Error('cut');
          },
        }),
      /cut/,
    );
    assert.equal(call.readHead().image.id, 'cp1');
    assert.throws(() => call.checkpoint(request('cp3'), 1), /uncertain/);
    const cold = LifecycleFacts.reopen(store, 'parent');
    assert.equal(cold.readHead().image.id, cut === 'committed' ? 'cp2' : 'cp1');
    assert.equal(cold.readHead().image.frame.children[0].state.kind, cut === 'committed' ? 'returned' : 'waiting');
  });
}

test('finish receipt loss leaves durable final delivery, never a rewritten old image', (t) => {
  const { store, call } = setup(t);
  call.registerChild(child());
  call.checkpoint(request(), 0);
  call.returned('child', failed(false), progress());
  assert.throws(
    () =>
      call.finish({ status: 'failed' }, 1, {
        fault: (at) => {
          if (at === 'committed') throw new Error('receipt lost');
        },
      }),
    /receipt lost/,
  );
  assert.equal(call.durableDelivery, undefined);
  const cold = LifecycleFacts.reopen(store, 'parent');
  assert.equal(cold.durableDelivery.status, 'failed');
  assert.equal(cold.readHead().image.frame.children[0].state.kind, 'waiting');
  assert.equal(cold.relation('child').returned.status, 'failed');
});

test('revision conflicts reject a stale writer, and missing facts reject cold reconstruction', (t) => {
  const { store, call } = setup(t);
  call.registerChild(child());
  call.checkpoint(request(), 0);
  const stale = LifecycleFacts.reopen(store, 'parent');
  call.checkpoint(request('cp2'), 1);
  assert.throws(() => stale.checkpoint(request('stale'), 1), /Revision conflict/);
  const material = [...call.encodingCounts().keys()].find((id) => id.includes(':material:'));
  store.db.prepare('DELETE FROM facts WHERE id=?').run(material);
  assert.throws(() => LifecycleFacts.reopen(store, 'parent'), /fact/i);
});

test('old boundary bodies are encoded once, while explicit full projection is still counted', (t) => {
  const { store, call } = setup(t);
  for (let index = 0; index < 32; index++) {
    const id = `child-${index}`;
    call.registerChild(child(id, index));
    call.returned(id, succeeded({ text: 'x'.repeat(256) }), progress({ text: id }));
    call.receiving(id);
    call.received(id, 'accepted', { number: index });
    const previous = call.encodingCounts();
    call.checkpoint(request(`cp${index}`), index);
    for (const [fact, count] of previous) assert.equal(call.encodingCounts().get(fact), count);
  }
  assert.equal(call.stats.boundaries, 128);
  assert.equal(
    [...call.encodingCounts().values()].every((count) => count === 1),
    true,
  );
  assert.equal(call.encodingCounts().size, 161); // input + 128 boundaries + 32 point requests
  assert.equal(store.stats.oldBodyReads, 0);
  assert.equal(call.stats.projectedChildren, 528, 'Full v5 projection remains explicit O(history)');
  const cold = LifecycleFacts.reopen(store, 'parent');
  assert.equal(cold.stats.coldBoundaries, 128);
  assert.deepEqual(cloneCheckpointImage(cold.readHead().image), call.readHead().image);
});

test('a well-formed generic carrier cannot forge the boundary selected by a checkpoint', (t) => {
  const store = new FactStore();
  t.after(() => store.close());
  const format = 'lifecycle-facts-study@1';
  const carrier = new FactCall(store, carrierIdentity('parent', null, 'lifecycle:group', 0, format), { format, identity: owner, input: {}, contract });
  const first = carrier.capture({ kind: 'lifecycle-boundary@1', owner: 'parent', sequence: 1, previous: null, type: 'register', payload: child() });
  const second = carrier.capture({ kind: 'lifecycle-boundary@1', owner: 'parent', sequence: 2, previous: first, type: 'returned', payload: { childId: 'child', outcome: succeeded('done'), progress: progress() } });
  const checkpoint = carrier.capture({ kind: 'lifecycle-checkpoint@1', owner: 'parent', tail: first, request: request() });
  carrier.save('lifecycle-head', { format, tail: second, checkpoint, delivery: null });
  assert.throws(() => LifecycleFacts.reopen(store, 'parent'), /publication boundary/);
});

test('pre-run cancellation records round-zero diagnostics without granting recovery', (t) => {
  const { store, call } = setup(t);
  call.registerChild(child());
  call.checkpoint(request(), 0);
  call.returned('child', failed(false), { ...progress(), round: 0 });
  assert.equal(call.relation('child').returned.status, 'failed');
  assert.equal(call.relation('child').progress.round, 0);
  assert.throws(() => call.projectFrame(), /Unstarted child progress/);
  assert.throws(() => call.checkpoint(request('cp2'), 1), /Unstarted child progress/);
  call.finish({ status: 'cancelled' }, 1);
  const cold = LifecycleFacts.reopen(store, 'parent');
  assert.equal(cold.relation('child').progress.round, 0);
  assert.equal(cold.readHead().image.frame.children[0].state.kind, 'waiting');
  assert.equal(cold.durableDelivery.status, 'cancelled');
});

test('a claimed receivable flag cannot promote round-zero diagnostics into work', (t) => {
  const { call } = setup(t);
  call.registerChild(child());
  assert.throws(() => call.returned('child', succeeded('impossible'), { ...progress(), round: 0 }), /Unstarted child/);
  assert.equal(call.relation('child').returned, null);
  call.returned('child', failed(true), { ...progress(), round: 0 });
  assert.throws(() => call.receiving('child'), /Unstarted child failure/);
  assert.throws(() => call.received('child', 'handled', 'fallback'), /not started/);
  assert.throws(() => call.projectFrame(), /Unstarted child progress/);
});
