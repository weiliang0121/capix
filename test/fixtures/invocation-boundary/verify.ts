import assert from 'node:assert/strict';
import { cloneCheckpointHead, MemoryCheckpointStore } from '@capix/checkpoint';
import type { CheckpointCodec } from '@capix/contracts';
import { CallableContext, Invocation, attachInvocationResources, InvocationObservation, ObserverSession, prepareCheckpointRestoration, type InvocationWork, type InvocationObserver } from '@capix/invocation';

// This is a module-boundary probe, not a replacement for Runner or author Work.
// The host supplies already-fixed behavior; there is no structure, Binder or registry.
const facts: string[] = [];
const observation = new InvocationObservation([new ObserverSession<InvocationObserver>({ observe: (fact) => facts.push(fact.kind) }, 'propagate')], new Map());
const context = new CallableContext<number, number>(3, 'scene');
let childAccepted = false;
const work: InvocationWork<number, number, CallableContext<number, number>> = {
  async execute(current, parent) {
    const childContext = new CallableContext<number, number>(current.input + 1, 'node');
    const child = new Invocation({ context: childContext, signal: childContext.signal, parent: { invocation: parent, declarationPosition: 0 }, work: { execute: () => childContext.input * 2 } });
    attachInvocationResources(child, childContext.resources);
    await child.run();
    const relation = parent.children.get(child);
    assert.equal(relation.returned?.status, 'succeeded');
    const beforeReception = relation.reception;
    assert.equal(beforeReception.status, 'pending');
    const value = await relation.accept((output) => output);
    childAccepted = relation.reception.status === 'accepted';
    return value;
  },
};
const invocation = new Invocation({ context, signal: context.signal, work, observation });
attachInvocationResources(invocation, context.resources);
const parentResult = await invocation.run();
assert.equal(context.status, 'succeeded');

// Restoring a fixed checkpoint also needs only the live call mechanism and CP store.
const numberCodec: CheckpointCodec<number> = {
  encode: (value) => value,
  decode(value) {
    if (typeof value !== 'number') throw new TypeError('Expected number');
    return value;
  },
};
const originalStore = new MemoryCheckpointStore();
const originalContext = new CallableContext<number, number>(9, 'node');
let serializedCheckpoint = '';
let bodyCalls = 0;
const resumedWork: InvocationWork<number, number, CallableContext<number, number>> = {
  execute() {
    throw new Error('Restoration must not replay the original body');
  },
  checkpoint: { key: 'isolated-call', version: 1, input: numberCodec, output: numberCodec, points: { prepared: { state: numberCodec, execute: (current, _invocation, state: number) => current.input + state } } },
};
const originalWork: InvocationWork<number, number, CallableContext<number, number>> = {
  checkpoint: resumedWork.checkpoint,
  execute(current, call) {
    bodyCalls += 1;
    assert.ok(call.checkpointWriter);
    call.checkpointWriter.save('prepared', current.input);
    // Snapshot the nonterminal saved boundary, then allow the old run to finish.
    // Only this JSON crosses into the newly constructed store and invocation below.
    serializedCheckpoint = JSON.stringify(originalStore.read(current.id));
    return current.input * 2;
  },
};
const original = new Invocation({ context: originalContext, signal: originalContext.signal, work: originalWork, checkpoints: { store: originalStore } });
attachInvocationResources(original, originalContext.resources);
assert.equal(await original.run(), 18);
assert.equal(originalStore.read(originalContext.id)?.delivery?.status, 'succeeded');
const saved = cloneCheckpointHead(JSON.parse(serializedCheckpoint));
assert.equal(saved.delivery, undefined);
const store = new MemoryCheckpointStore();
store.save(saved.image, 0);
const restore = prepareCheckpointRestoration({ store }, resumedWork.checkpoint, saved.image.frame.owner.contextId, { kind: 'node' });
const resumedContext = new CallableContext<number, number>(9, 'node');
resumedContext.installCheckpoint({ id: saved.image.frame.owner.contextId, round: 1, currentInput: 9 });
const resumed = new Invocation({ context: resumedContext, signal: resumedContext.signal, work: resumedWork, checkpoints: { store }, restore });
attachInvocationResources(resumed, resumedContext.resources);
const recoveredResult = await resumed.run();
assert.equal(bodyCalls, 1);
assert.notEqual(resumedContext, originalContext);
const checkpointFinished = store.read(resumedContext.id)?.delivery?.status === 'succeeded';

async function unavailable(specifier: string): Promise<boolean> {
  try {
    await import(specifier);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND';
  }
}

process.stdout.write(JSON.stringify({ parentResult, childAccepted, observed: facts.includes('started') && facts.includes('finished'), recoveredResult, checkpointFinished, runtimeUnavailable: await unavailable('@capix/server-runtime'), structureUnavailable: await unavailable('@capix/structure') }));
