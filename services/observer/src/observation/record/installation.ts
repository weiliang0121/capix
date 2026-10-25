import { type Clock, type ChangeCapture } from '@capix/server-runtime';
import { RecordBook, Recorder, bindRecording, type RecordingInstallation } from '@capix/server-runtime/recording';
import type { RecordChangeEvent, RecordingArchive } from '@capix/protocol';
import type { ChangeConsumer } from '../../assembly/changes.js';
import type { SqliteObserverStore } from '../../persistence/store.js';
import { RecordSource } from './source.js';

/** One recording installation owns its source and durable session, never content or the database. */
export class ObserverRecording {
  readonly book: RecordBook;
  readonly archives: readonly RecordingArchive[];
  readonly recorder: Recorder;
  readonly installation: RecordingInstallation;
  readonly source: RecordSource;
  #opened = false;
  #closed = false;

  constructor(
    changes: ChangeCapture<RecordChangeEvent>,
    consumer: ChangeConsumer,
    private readonly options: { readonly clock: Clock; readonly persistence?: SqliteObserverStore; readonly conversationId?: string },
  ) {
    this.options = Object.freeze({ ...options });
    let book = new RecordBook();
    let archives: readonly RecordingArchive[] = [];
    let failure: { readonly error: unknown } | undefined;
    try {
      const saved = options.persistence?.loadRecording(options.conversationId);
      if (saved) {
        book = RecordBook.restore(saved.book);
        archives = saved.archives;
      }
    } catch (error) {
      // Corrupt optional history disables its observation. A database fault is
      // required infrastructure failure and cannot become an in-memory fallback.
      if (options.persistence?.failure) throw error;
      failure = { error };
    }
    this.book = book;
    this.archives = archives;
    this.recorder = new Recorder(book, {
      clock: options.clock,
      changes: {
        capture: (event) => {
          this.options.persistence?.applyRecordChange(event);
          changes.capture(event);
        },
      },
    });
    this.source = new RecordSource(this.recorder, consumer);
    try {
      if (failure) this.source.invalidate(failure.error);
      this.options.persistence?.openRecording(this.recorder.id, options.conversationId);
      this.#opened = true;
      this.installation = bindRecording(this.recorder, { invalidate: (error) => this.invalidate(error) });
    } catch (error) {
      try {
        this.abort(error);
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Recording installation and cleanup failed');
      }
      throw error;
    }
  }

  /** A missing fact invalidates this source even when its durable marker cannot be updated. */
  invalidate(error: unknown): void {
    const failures: unknown[] = [];
    for (const release of [() => this.options.persistence?.invalidateRecording(this.recorder.id), () => this.source.invalidate(error)]) {
      try {
        release();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Recording invalidation failed');
  }

  /** Failed environment installation cannot seal a partially established recording. */
  abort(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const release of [
      () => {
        try {
          this.source.invalidate(error);
        } catch (failure) {
          failures.push(failure);
          this.source.close();
        }
      },
      () => {
        if (this.#opened) this.options.persistence?.invalidateRecording(this.recorder.id);
      },
    ]) {
      try {
        release();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Recording installation cleanup failed');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const release of [() => this.options.persistence?.sealRecording(this.recorder.id, this.recorder.revision), () => this.source.close()]) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Recording cleanup failed');
  }
}
