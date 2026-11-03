import { closeSync, fsyncSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { RecordBook, Recorder } from '@capix/records';
import { createConversationRecording } from '../recording/index.js';

/** A CLI output file, reserved before accepting input; it is not a recording persistence store. */
export class RecordingFile {
  readonly #recorder = new Recorder(new RecordBook());
  #installation?: ReturnType<typeof createConversationRecording>;
  #incomplete = false;
  #descriptor: number | undefined;

  private constructor(descriptor: number) {
    this.#descriptor = descriptor;
  }

  static open(path: string, database: string): RecordingFile {
    const target = canonicalPath(path);
    const content = canonicalPath(database);
    if ([content, `${content}-wal`, `${content}-shm`].includes(target)) throw new Error('--records must not target the conversation database or its SQLite sidecars');
    // Exclusive creation also rejects directories, symlinks and existing output files.
    const descriptor = openSync(path, 'wx', 0o600);
    try {
      return new RecordingFile(descriptor);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  install(scene: Parameters<typeof createConversationRecording>[0]) {
    if (this.#descriptor === undefined || this.#installation) throw new Error('Recording file is closed or already installed');
    this.#installation = createConversationRecording(scene, this.#recorder, {
      invalidate: () => {
        this.#incomplete = true;
      },
    });
    return this.#installation;
  }

  /** Called only after local delivery and independent external senders have settled. */
  save(): void {
    if (this.#descriptor === undefined) throw new Error('Recording file is closed');
    if (!this.#installation) return;
    const archive = {
      format: 'capix.conversation.recording',
      version: 1,
      recorderId: this.#recorder.id,
      rootId: this.#installation.root.id,
      integrity: this.#incomplete ? 'incomplete' : 'intact',
      book: this.#recorder.book.exportState(),
    };
    writeFileSync(this.#descriptor, `${JSON.stringify(archive)}\n`, 'utf8');
    fsyncSync(this.#descriptor);
  }

  close(): void {
    const descriptor = this.#descriptor;
    if (descriptor === undefined) return;
    this.#descriptor = undefined;
    closeSync(descriptor);
  }
}

/** Resolve existing ancestors too, so aliases cannot make a new database overwrite the reserved file. */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent), basename(absolute));
  }
}
