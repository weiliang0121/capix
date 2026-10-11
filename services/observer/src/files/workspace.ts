import { constants, type Stats } from 'node:fs';
import { lstat, realpath, open, link, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, sep, dirname, join } from 'node:path';
import { DeclaredException, InvocationCancelled, type ProgressChannel } from '@capix/server-runtime';
import type { FileReceipt } from '@capix/protocol';
import { FileAccessException, fileFailure } from './error.js';
import { isRelativeFilePath } from './path.js';
import type { TextDocument, FileProgress } from './types.js';

interface DirectoryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
interface FileLocation {
  readonly target: string;
  readonly directories: readonly DirectoryIdentity[];
}
export interface WorkspaceFilesOptions {
  readonly root: string;
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
}

/** Host-owned local workspace, not an OS sandbox against concurrent hostile directory mutation. */
export class WorkspaceFiles {
  readonly configuration: { readonly maxReadBytes: number; readonly maxWriteBytes: number };
  readonly #root: string;
  #identity?: DirectoryIdentity;

  constructor(options: WorkspaceFilesOptions) {
    if (typeof options.root !== 'string' || !options.root.trim()) throw new TypeError('A file workspace needs a root directory');
    this.#root = resolve(options.root);
    const maxReadBytes = options.maxReadBytes ?? 64 * 1024;
    const maxWriteBytes = options.maxWriteBytes ?? 64 * 1024;
    for (const limit of [maxReadBytes, maxWriteBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024) throw new RangeError('File limits must be integers between 1 and 65536 bytes');
    }
    this.configuration = Object.freeze({ maxReadBytes, maxWriteBytes });
  }

  async readText(path: string, signal?: AbortSignal): Promise<TextDocument> {
    let handle: FileHandle | undefined;
    try {
      this.validatePath('read', path);
      requireActive(signal);
      const location = await this.locate('read', path);
      const entry = await lstat(location.target);
      if (entry.isSymbolicLink()) throw fileFailure('read', path, 'symbolic-link');
      if (!entry.isFile()) throw fileFailure('read', path, 'not-file');
      if (entry.size > this.configuration.maxReadBytes) throw fileFailure('read', path, 'too-large');
      requireActive(signal);
      handle = await open(location.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!before.isFile()) throw fileFailure('read', path, 'not-file');
      if (before.dev !== entry.dev || before.ino !== entry.ino) throw fileFailure('read', path, 'changed');
      await this.verify('read', path, location.directories);
      const buffer = Buffer.alloc(this.configuration.maxReadBytes + 1);
      let bytes = 0;
      let ended = false;
      while (!ended && bytes < buffer.length) {
        requireActive(signal);
        const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
        bytes += result.bytesRead;
        ended = result.bytesRead === 0;
      }
      if (bytes > this.configuration.maxReadBytes) throw fileFailure('read', path, 'too-large');
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw fileFailure('read', path, 'changed');
      requireActive(signal);
      const content = buffer.subarray(0, bytes);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
        if (text.includes('\0')) throw new TypeError('NUL is not accepted in text');
      } catch (error) {
        throw fileFailure('read', path, 'encoding', error);
      }
      await handle.close();
      handle = undefined;
      return Object.freeze({ path, text, bytes, digest: digest(content) });
    } catch (error) {
      throw this.failure('read', path, error);
    } finally {
      try {
        await handle?.close();
      } catch {
        // Best-effort handle cleanup retains the original read failure.
      }
    }
  }

  async createText(path: string, text: string, options: { readonly signal?: AbortSignal; readonly progress?: ProgressChannel<FileProgress> } = {}): Promise<FileReceipt> {
    let handle: FileHandle | undefined;
    let stage: string | undefined;
    let publicationAttempted = false;
    options.progress?.publish(Object.freeze({ kind: 'started', path }));
    try {
      this.validatePath('create', path);
      requireActive(options.signal);
      if (typeof text !== 'string' || text.includes('\0')) throw fileFailure('create', path, 'encoding');
      if (Buffer.byteLength(text, 'utf8') > this.configuration.maxWriteBytes) throw fileFailure('create', path, 'too-large');
      const buffer = Buffer.from(text, 'utf8');
      if (buffer.toString('utf8') !== text) throw fileFailure('create', path, 'encoding');
      const receipt: FileReceipt = Object.freeze({ path, bytes: buffer.length, digest: digest(buffer) });
      const location = await this.locate('create', path);
      requireActive(options.signal);
      const stagePath = join(dirname(location.target), `.capix-${randomUUID()}.tmp`);
      handle = await open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      stage = stagePath;
      await handle.writeFile(buffer, { signal: options.signal });
      const staged = await handle.stat();
      await handle.close();
      handle = undefined;
      await this.verify('create', path, location.directories);
      const candidate = await lstat(stage);
      if (!candidate.isFile() || candidate.dev !== staged.dev || candidate.ino !== staged.ino || candidate.size !== buffer.length) throw fileFailure('create', path, 'changed');
      requireActive(options.signal);
      publicationAttempted = true;
      // Hard-link creation is exclusive and exposes only the already completed file. rename would overwrite.
      await link(stage, location.target);
      // This fact precedes cleanup, cancellation delivery and the resource returned observation.
      options.progress?.publish(Object.freeze({ kind: 'created', receipt }));
      return receipt;
    } catch (error) {
      const knownNoPublication = !publicationAttempted || noLinkCreated(error);
      const abortedWrite = options.signal?.aborted && (error === options.signal.reason || (!publicationAttempted && error instanceof Error && error.name === 'AbortError'));
      const failure = abortedWrite ? new InvocationCancelled(options.signal!, { cause: error }) : this.failure('create', path, error);
      const reason = failure instanceof InvocationCancelled ? 'cancelled' : 'failed';
      options.progress?.publish(Object.freeze(knownNoPublication ? { kind: 'not-created', path, reason } : { kind: 'unconfirmed', path }));
      throw failure;
    } finally {
      try {
        await handle?.close();
      } catch {
        // Closing a staging handle cannot retract a publication or replace the original failure.
      }
      if (stage) {
        try {
          await unlink(stage);
        } catch {
          // A private staging file may remain; never delete the published target to compensate.
        }
      }
    }
  }

  private validatePath(operation: 'read' | 'create', path: string): void {
    if (!isRelativeFilePath(path)) throw fileFailure(operation, path, 'path');
  }
  private async locate(operation: 'read' | 'create', path: string): Promise<FileLocation> {
    const root = await realpath(this.#root);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw fileFailure(operation, path, 'unavailable');
    const identity = directory(root, rootStat);
    if (this.#identity && (this.#identity.path !== root || this.#identity.dev !== identity.dev || this.#identity.ino !== identity.ino)) throw fileFailure(operation, path, 'changed');
    this.#identity ??= identity;
    const target = resolve(root, path);
    const within = relative(root, target);
    if (!within || within.startsWith(`..${sep}`) || within === '..') throw fileFailure(operation, path, 'outside');
    const directories = [identity];
    let current = root;
    for (const part of path.split('/').slice(0, -1)) {
      current = join(current, part);
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw fileFailure(operation, path, 'symbolic-link');
      if (!stats.isDirectory()) throw fileFailure(operation, path, 'unavailable');
      directories.push(directory(current, stats));
    }
    return { target, directories };
  }
  private async verify(operation: 'read' | 'create', path: string, directories: readonly DirectoryIdentity[]): Promise<void> {
    for (const expected of directories) {
      const actual = await lstat(expected.path);
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw fileFailure(operation, path, 'changed');
    }
  }
  private failure(operation: 'read' | 'create', path: string, error: unknown): Error {
    if (error instanceof InvocationCancelled || (error instanceof DeclaredException && error.contract === FileAccessException)) return error;
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    const reason = code === 'EEXIST' ? 'exists' : code === 'ELOOP' ? 'symbolic-link' : code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' ? 'unavailable' : 'io';
    return fileFailure(operation, path, reason, error);
  }
}

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InvocationCancelled(signal);
}
function digest(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}
function directory(path: string, stats: Stats): DirectoryIdentity {
  return Object.freeze({ path, dev: stats.dev, ino: stats.ino });
}
function noLinkCreated(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return ['EEXIST', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS', 'EXDEV', 'ENOSPC', 'EDQUOT', 'EMLINK', 'ELOOP', 'ENAMETOOLONG'].includes(String(error.code));
}
