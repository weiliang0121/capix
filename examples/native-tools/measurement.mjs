import { performance } from 'node:perf_hooks';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { collectionLimit, fixed, valueLimit } from './value.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const interactionStateLimit = 2 * valueLimit + 64 * 1024;

function captureInteractionState(state) {
  const captured = fixed(state, interactionStateLimit);
  // An envelope contains two independently bounded external values, not one
  // externally supplied value allowed to use the larger aggregate budget.
  fixed(captured.request);
  if (captured.feedback) fixed(captured.feedback.payload);
  return captured;
}

/** Instrument real public commits, never manufacture or edit a Frame. */
export class CheckpointJournal extends MemoryCheckpointStore {
  writes = [];
  samples = [];
  capture = () => undefined;
  save(image, revision) {
    const start = performance.now();
    const receipt = super.save(image, revision);
    const elapsedMs = performance.now() - start;
    const saved = this.read(receipt.contextId).image;
    this.writes.push({ image: saved, revision });
    this.samples.push({ kind: 'save', contract: image.contract.key, point: image.point, contextId: image.frame.owner.contextId, children: image.frame.children.length, value: saved, elapsedMs, snapshot: this.capture() });
    return receipt;
  }
  finish(id, revision, delivery) {
    const start = performance.now();
    const receipt = super.finish(id, revision, delivery);
    const elapsedMs = performance.now() - start;
    const saved = this.read(id).delivery;
    this.writes.push({ id, revision, delivery: saved });
    this.samples.push({ kind: 'finish', contextId: id, value: saved, elapsedMs, snapshot: this.capture() });
    return receipt;
  }
  prefix(index) {
    const journal = new CheckpointJournal();
    for (const write of this.writes.slice(0, index + 1)) {
      if (write.image) journal.save(write.image, write.revision);
      else journal.finish(write.id, write.revision, write.delivery);
    }
    journal.writes = [];
    journal.samples = [];
    return journal;
  }
  report() {
    // Size measurement occurs after execution, not inside the timed save path.
    const samples = this.samples.map((item) => ({ ...item, bytes: bytes(item.value) }));
    const saves = samples.filter((item) => item.kind === 'save');
    return {
      save: saves.length,
      finish: this.samples.length - saves.length,
      cumulativeBytes: samples.reduce((sum, item) => sum + item.bytes, 0),
      maximumImageBytes: Math.max(0, ...saves.map((item) => item.bytes)),
      storeSynchronousMs: this.samples.reduce((sum, item) => sum + item.elapsedMs, 0),
      writerSynchronousMs: saves.reduce((sum, item) => sum + (item.writerMs ?? 0), 0),
      points: saves.map(({ contract, point, children, bytes: size, elapsedMs, writerMs }) => ({ contract, point, children, bytes: size, storeMs: elapsedMs, writerMs })),
    };
  }
}

export class InteractionJournal {
  values = new Map();
  writes = 0;
  writtenBytes = 0;
  committed = () => {};
  create(state) {
    state = captureInteractionState(state);
    if (this.values.has(state.id)) throw new Error('Duplicate interaction');
    this.#install(state);
    return undefined;
  }
  commit(change) {
    const captured = fixed(change, interactionStateLimit + 1024);
    const { expectedRevision } = captured;
    const state = captureInteractionState(captured.state);
    const previous = this.values.get(state.id);
    if (previous?.revision !== expectedRevision) throw new Error('Interaction revision conflict');
    this.#install(state);
    return undefined;
  }
  #install(state) {
    this.writes++;
    this.writtenBytes += bytes(state);
    this.values.set(state.id, state);
    this.committed(state);
  }
  read(id) {
    return this.values.get(id);
  }
  snapshot() {
    return fixed([...this.values.values()], collectionLimit);
  }
  report() {
    return { writes: this.writes, writtenBytes: this.writtenBytes, retainedBytes: [...this.values.values()].reduce((sum, state) => sum + bytes(state), 0), requests: this.values.size };
  }
  static restore(values) {
    values = fixed(values, collectionLimit);
    if (!Array.isArray(values)) throw new TypeError('Interaction snapshot must be an array');
    const journal = new InteractionJournal();
    for (const value of values) {
      const state = captureInteractionState(value);
      if (journal.values.has(state.id)) throw new Error('Duplicate saved interaction');
      journal.values.set(state.id, state);
    }
    return journal;
  }
}
