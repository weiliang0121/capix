import { performance } from 'node:perf_hooks';

const byteLength = (value) => Buffer.byteLength(JSON.stringify(value));

/** Benchmark-local numeric observation; never retain a Work, image or business value. */
export class Measurement {
  samples = [];
  counters = Object.create(null);
  stores = { saveCount: 0, finishCount: 0, saveMs: 0, finishMs: 0, byOwner: {}, finishes: [] };
  #current;
  #owners = new Map();
  constructor(mode) {
    this.mode = mode;
  }

  codec(name, validate) {
    const method = (kind) => (value) => {
      if (this.mode === 'diagnostic') this.increment(`${name}.${kind}`);
      validate(value);
      return value;
    };
    return { encode: method('encode'), decode: method('decode') };
  }

  increment(name) {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
  }

  work(work, owner, describe) {
    if (this.mode === 'control') return work;
    const original = work.checkpoint;
    return {
      ...work,
      checkpoint: Object.assign(
        (options) => {
          const slot = { id: this.samples.length, owner, point: options.point.name, ...describe(options), succeeded: false, checkpointMs: null, storeMs: this.mode === 'timing' ? 0 : null, storeCalls: 0 };
          const previous = this.#current;
          const before = this.mode === 'diagnostic' ? { ...this.counters } : undefined;
          this.samples.push(slot);
          this.#current = slot;
          const started = this.mode === 'timing' ? performance.now() : 0;
          try {
            const result = original(options);
            slot.succeeded = true;
            return result;
          } finally {
            if (this.mode === 'timing') slot.checkpointMs = performance.now() - started;
            this.#current = previous;
            if (before)
              slot.codecCalls = Object.fromEntries(
                Object.entries(this.counters)
                  .map(([key, count]) => [key, count - (before[key] ?? 0)])
                  .filter(([, count]) => count),
              );
          }
        },
        { select: original.select },
      ),
    };
  }

  store(actual) {
    return {
      read: (id) => actual.read(id),
      save: (image, revision) => {
        const slot = this.#current;
        const owner = image.contract.key.split('.').at(-1);
        const started = this.mode === 'timing' ? performance.now() : 0;
        let succeeded = false;
        try {
          const result = actual.save(image, revision);
          succeeded = true;
          return result;
        } finally {
          const elapsed = this.mode === 'timing' ? performance.now() - started : null;
          if (slot) {
            slot.storeCalls++;
            if (elapsed !== null) slot.storeMs += elapsed;
          }
          if (elapsed !== null) this.stores.saveMs += elapsed;
          if (succeeded) {
            this.stores.saveCount++;
            const counts = (this.stores.byOwner[owner] ??= { saves: 0, finishes: 0 });
            counts.saves++;
            this.#owners.set(image.frame.owner.contextId, owner);
          }
          if (this.mode === 'diagnostic' && slot) {
            slot.imageBytes = byteLength(image);
            slot.representation = image.kind === 'commit' ? 'delta' : 'full';
            if (image.kind === 'commit') {
              const body = (ref) => image.values.find((value) => value.id === ref.id)?.value;
              const bytes = (ref) => {
                const value = body(ref);
                return value === undefined ? 0 : byteLength(value);
              };
              slot.fieldBytes = { input: bytes(image.frame.input), currentInput: image.frame.currentInput.id === image.frame.input.id ? 0 : bytes(image.frame.currentInput), children: byteLength(image.children), state: bytes(image.state), references: bytes(image.references) };
              slot.valueBlocks = image.values.length;
              slot.relationEntries = image.children.length;
              if (image.references.kind === 'slots') {
                slot.fieldBytes.references = byteLength({ references: image.references, selectionChanges: image.selectionChanges ?? [] });
                slot.selectionAppends = (image.selectionChanges ?? []).reduce((sum, change) => sum + (change.append?.length ?? 0), 0);
                slot.selectionRemovals = (image.selectionChanges ?? []).reduce((sum, change) => sum + (change.remove?.length ?? 0), 0);
                slot.selectionChanges = image.selectionChanges?.length ?? 0;
                // Submission counts do not infer how many checks the layers perform.
                slot.inferredReferenceComparisons = null;
              } else {
                const refs = Object.values(body(image.references) ?? {}).flatMap((value) => (Array.isArray(value) ? value : [value]));
                // Both checks use context-id indexes; this is inferred work, not CPU instructions.
                slot.inferredReferenceComparisons = 2 * refs.length;
              }
            } else {
              slot.fieldBytes = Object.fromEntries(['input', 'currentInput', 'children'].map((key) => [key, byteLength(image.frame[key])]));
              slot.fieldBytes.state = byteLength(image.state);
              slot.fieldBytes.references = byteLength(image.references);
              slot.relationEntries = image.frame.children.length;
              const refs = Object.values(image.references).flatMap((value) => (Array.isArray(value) ? value : [value]));
              const positions = new Map(image.frame.children.map((child, index) => [child.identity.contextId, index + 1]));
              // Two current full-ref checks each scan children from its beginning.
              // This is inferred algorithm work, not an instrumented comparison counter.
              slot.inferredReferenceComparisons = 2 * refs.reduce((sum, ref) => sum + (positions.get(ref.contextId) ?? image.frame.children.length), 0);
            }
            slot.storeSucceeded = succeeded;
          }
        }
      },
      finish: (id, revision, delivery) => {
        const owner = this.#owners.get(id) ?? 'unknown';
        const started = this.mode === 'timing' ? performance.now() : 0;
        let succeeded = false;
        try {
          const result = actual.finish(id, revision, delivery);
          succeeded = true;
          return result;
        } finally {
          const elapsed = this.mode === 'timing' ? performance.now() - started : null;
          if (elapsed !== null) this.stores.finishMs += elapsed;
          if (succeeded) {
            this.stores.finishCount++;
            const counts = (this.stores.byOwner[owner] ??= { saves: 0, finishes: 0 });
            counts.finishes++;
          }
          this.stores.finishes.push({ owner, succeeded, status: delivery.status, elapsedMs: elapsed, ...(this.mode === 'diagnostic' ? { bytes: byteLength(delivery) } : {}) });
          this.#owners.delete(id);
        }
      },
    };
  }

  summary() {
    return {
      codecCalls: { ...this.counters },
      checkCalls: Object.entries(this.counters)
        .filter(([key]) => key.endsWith('.check'))
        .reduce((sum, [, count]) => sum + count, 0),
      payloadMeaning: 'submitted delta/finish bytes; not full logical images or physical I/O',
      submittedPayload: this.mode === 'diagnostic' ? this.samples.reduce((sum, sample) => sum + (sample.storeSucceeded ? sample.imageBytes : 0), 0) + this.stores.finishes.reduce((sum, sample) => sum + (sample.succeeded ? sample.bytes : 0), 0) : null,
      relationEntries: this.mode === 'diagnostic' ? this.samples.reduce((sum, sample) => sum + (sample.relationEntries ?? 0), 0) : null,
    };
  }
}
