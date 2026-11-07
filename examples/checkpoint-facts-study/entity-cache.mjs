import assert from 'node:assert/strict';
import { StableValues } from './stable.mjs';

// Isolated experiment over public entity APIs. These wrappers are NOT production
// resource endpoints: resource-window authorization still belongs to the caller.
// Only known immutable entity snapshots enter these caches; Object.freeze alone
// never grants StableValues evidence to an arbitrary external object.
export class TranscriptSnapshots {
  #transcript;
  #values;
  #limit;
  #prefixes = new Map();
  reads = 0;
  hits = 0;
  sourceEntries = 0;

  constructor(transcript, { values = new StableValues(), maxPrefixes = 2 } = {}) {
    assert.ok(Number.isSafeInteger(maxPrefixes) && maxPrefixes > 0);
    this.#transcript = transcript;
    this.#values = values;
    this.#limit = maxPrefixes;
  }

  read(end = this.#transcript.length) {
    assert.ok(Number.isSafeInteger(end) && end >= 0 && end <= this.#transcript.length, 'Invalid prefix end');
    const cached = this.#prefixes.get(end);
    if (cached) {
      this.#prefixes.delete(end);
      this.#prefixes.set(end, cached);
      this.hits++;
      return cached;
    }
    // This bound Transcript is append-only. Its exact [0,end) prefix remains
    // valid after later appends; a different entity requires a different cache.
    const source = this.#transcript.snapshot(end);
    this.reads++;
    this.sourceEntries += source.length;
    const fixed = this.#values.own(source);
    this.#prefixes.set(end, fixed);
    if (this.#prefixes.size > this.#limit) this.#prefixes.delete(this.#prefixes.keys().next().value);
    return fixed;
  }

  retention() {
    // Measurement only: do not perform this scan on the read hot path.
    return { prefixes: this.#prefixes.size, referenceSlots: [...this.#prefixes.values()].reduce((sum, prefix) => sum + prefix.length, 0) };
  }
}

export class MemorySnapshots {
  #memory;
  #values;
  #raw;
  #fixed;
  reads = 0;
  fixedVersions = 0;
  hits = 0;

  constructor(memory, values = new StableValues()) {
    this.#memory = memory;
    this.#values = values;
  }

  read() {
    // Memory.snapshot returns its current immutable content object. This is a
    // process-local version token from this known entity, not a durable version.
    const raw = this.#memory.snapshot();
    this.reads++;
    if (raw === this.#raw) {
      this.hits++;
      return this.#fixed;
    }
    const fixed = this.#values.own(raw);
    this.#raw = raw;
    this.#fixed = fixed;
    this.fixedVersions++;
    return fixed;
  }
}

export class ViewSnapshots {
  #view;
  #sources;
  #values;
  #key;
  #fixed;
  indexReads = 0;
  indexedEntries = 0;
  captures = 0;
  hits = 0;

  constructor(view, sources, values = new StableValues()) {
    this.#view = view;
    this.#sources = Object.freeze({ ...sources });
    this.#values = values;
  }

  read() {
    // The public API verifies current source identity/scope/version by reading
    // the selected directory. Even a cache hit still performs that metadata
    // work; this experiment does NOT claim O(1) View reads.
    const index = this.#view.indexSync(this.#sources);
    this.indexReads++;
    this.indexedEntries += index.entries.length;
    const key = JSON.stringify(index.basis);
    if (key === this.#key) {
      this.hits++;
      return this.#fixed;
    }
    const captured = this.#view.captureSync(this.#sources, index);
    this.captures++;
    const fixed = this.#values.own(captured);
    this.#key = key;
    this.#fixed = fixed;
    return fixed;
  }
}

export function measureGrowingPrefixes(createTranscript, count) {
  const transcript = createTranscript();
  const values = new StableValues();
  const snapshots = new TranscriptSnapshots(transcript, { values, maxPrefixes: 2 });
  for (let index = 0; index < count; index++) {
    transcript.append({ role: 'user', content: 'fixed-size message' });
    snapshots.read();
    snapshots.read();
  }
  return { count, sourceReads: snapshots.reads, sourceEntries: snapshots.sourceEntries, cacheHits: snapshots.hits, fixingVisits: values.visits, retained: snapshots.retention() };
}
