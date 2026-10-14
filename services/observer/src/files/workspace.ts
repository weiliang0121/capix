import { constants, type Stats } from 'node:fs';
import { lstat, realpath, open, link, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, sep, dirname, join, isAbsolute } from 'node:path';
import { DeclaredException, InvocationCancelled, RuntimeError, type ProgressChannel } from '@capix/server-runtime';
import { isEqual } from 'es-toolkit/predicate';
import type { FileCreationOperation, FileCreationState, FileCreationPersistence } from './creation.js';
import type { FileReceipt, FileTask } from '@capix/protocol';
import { FileAccessException, fileFailure } from './error.js';
import { isRelativeFilePath } from './path.js';
import type { TextDocument, FileProgress, FileTaskInspection } from './types.js';

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
  readonly persistence?: FileCreationPersistence;
}

/** Host-owned local workspace, not an OS sandbox against concurrent hostile directory mutation. */
export class WorkspaceFiles {
  readonly configuration: { readonly maxReadBytes: number; readonly maxWriteBytes: number };
  /** Host continuation identity; public file configuration never exposes the workspace path. */
  readonly checkpointScope: string;
  readonly #root: string;
  #identity?: DirectoryIdentity;
  readonly #creations = new Map<string, FileCreationState>();
  readonly #persistence?: FileCreationPersistence;

  constructor(options: WorkspaceFilesOptions) {
    if (typeof options.root !== 'string' || !options.root.trim()) throw new TypeError('A file workspace needs a root directory');
    this.#root = resolve(options.root);
    this.#persistence = options.persistence;
    const maxReadBytes = options.maxReadBytes ?? 64 * 1024;
    const maxWriteBytes = options.maxWriteBytes ?? 64 * 1024;
    for (const limit of [maxReadBytes, maxWriteBytes]) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 * 1024) throw new RangeError('File limits must be integers between 1 and 65536 bytes');
    }
    this.configuration = Object.freeze({ maxReadBytes, maxWriteBytes });
    this.checkpointScope = digest(Buffer.from(JSON.stringify({ root: this.#root, maxReadBytes, maxWriteBytes }), 'utf8'));
  }

  /** The journal fixes intent before filesystem publication. An unresolved intent is never resent. */
  async createFixed(operation: FileCreationOperation, path: string, text: string, options: { readonly signal?: AbortSignal; readonly progress?: ProgressChannel<FileProgress> } = {}): Promise<FileReceipt> {
    if (!operation.contextId?.trim() || !operation.position?.trim()) throw new TypeError('File creation requires a fixed operation');
    this.validatePath('create', path);
    if (typeof text !== 'string' || text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text) throw fileFailure('create', path, 'encoding');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > this.configuration.maxWriteBytes) throw fileFailure('create', path, 'too-large');
    const request = Object.freeze({ operation: Object.freeze({ ...operation }), root: this.#root, path, bytes, digest: digest(Buffer.from(text, 'utf8')) });
    const key = JSON.stringify([operation.contextId, operation.position]);
    const previous = this.#persistence ? this.#persistence.read(operation) : this.#creations.get(key);
    if (previous) {
      if (!isEqual(previous.request, request)) throw new RuntimeError('FILE_CREATION_CONFLICT', '固定文件创建与原操作不一致。');
      if (!previous.receipt) throw new RuntimeError('FILE_CREATION_UNCONFIRMED', '文件创建已发起但没有确认凭据，不能自动重复写入。');
      const receipt = previous.receipt;
      if (receipt.path !== path || receipt.bytes !== bytes || receipt.digest !== request.digest) throw new RuntimeError('FILE_CREATION_CONFLICT', '文件创建凭据与固定内容不一致。');
      return Object.freeze({ ...receipt });
    }
    requireActive(options.signal);
    const pending = Object.freeze({ request });
    const created: unknown = this.#persistence?.create(pending);
    if (created !== undefined) {
      void Promise.resolve(created).catch(() => undefined);
      throw new TypeError('File creation persistence must be synchronous');
    }
    this.#creations.set(key, pending);
    const receipt = await this.createText(path, text, { ...options, durable: true });
    const complete = Object.freeze({ request, receipt });
    const committed: unknown = this.#persistence?.complete(complete);
    if (committed !== undefined) {
      void Promise.resolve(committed).catch(() => undefined);
      throw new TypeError('File creation persistence must be synchronous');
    }
    this.#creations.set(key, complete);
    return receipt;
  }

  /** Inspect only named paths. Actual read/create recheck independently; no handle survives this call. */
  async checkTask(task: FileTask, options: { readonly signal?: AbortSignal; readonly constraint?: FileTask } = {}): Promise<FileTaskInspection> {
    requireActive(options.signal);
    const normalized = this.normalizeTask(task);
    if (normalized.kind !== 'ready') return normalized;
    const candidate = normalized.task;
    if (options.constraint && (candidate.sourcePath !== options.constraint.sourcePath || candidate.output?.path !== options.constraint.output?.path)) return Object.freeze({ kind: 'revise', reason: 'constraint', feedback: '候选来源、目标和是否保存必须完整符合本次显式文件任务，不能自行增删或替换。' });
    if (candidate.sourcePath && candidate.sourcePath === candidate.output?.path) return Object.freeze({ kind: 'revise', reason: 'same-path', feedback: '来源与输出不能是同一路径。请依据用户已给出的要求修正候选；不能自行改名或把检查失败当作已执行。' });

    const firstPath = candidate.sourcePath ?? candidate.output!.path;
    const firstOperation = candidate.sourcePath ? 'read' : 'create';
    try {
      // A missing/broken workspace is an environment failure, not a request for another filename.
      await this.rootDirectory(firstOperation, firstPath);
      requireActive(options.signal);
    } catch (error) {
      throw this.failure(firstOperation, firstPath, error);
    }
    if (candidate.sourcePath) {
      const problem = await this.inspectPath('read', candidate.sourcePath, options.signal);
      if (problem) return problem;
    }
    if (candidate.output) {
      const problem = await this.inspectPath('create', candidate.output.path, options.signal);
      if (problem) return problem;
    }
    requireActive(options.signal);
    return normalized;
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

  async createText(path: string, text: string, options: { readonly signal?: AbortSignal; readonly progress?: ProgressChannel<FileProgress>; readonly durable?: boolean } = {}): Promise<FileReceipt> {
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
      if (options.durable) await handle.sync();
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
      if (options.durable) {
        const directory = await open(dirname(location.target), constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
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
  private normalizeTask(task: FileTask): FileTaskInspection {
    if (!task || typeof task !== 'object' || (task.sourcePath === undefined && task.output === undefined)) return Object.freeze({ kind: 'revise', reason: 'task-shape', feedback: '文件候选必须提供来源路径或输出路径。' });
    const paths: { sourcePath?: string; output?: { readonly path: string } } = {};
    for (const key of ['sourcePath', 'output'] as const) {
      const value = key === 'sourcePath' ? task.sourcePath : task.output?.path;
      if (value === undefined) {
        if (key === 'output' && task.output !== undefined) return Object.freeze({ kind: 'revise', reason: 'path', feedback: '输出候选缺少文件路径。' });
        continue;
      }
      if (typeof value !== 'string' || /[\\:\u0000-\u001f\u007f]/u.test(value)) return Object.freeze({ kind: 'revise', reason: 'path', feedback: '请保留用户指定的文件名，使用规范路径，不能包含控制字符、反斜线或路径跳转。' });
      let path = value;
      if (isAbsolute(path)) {
        if (
          !path
            .split('/')
            .slice(1)
            .every((part) => part.length > 0 && part !== '.' && part !== '..')
        )
          return Object.freeze({ kind: 'revise', reason: 'path', feedback: '绝对路径必须是规范路径，不能包含路径跳转或空路径段。' });
        path = relative(this.#root, path);
        if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return Object.freeze({ kind: 'needs-input', reason: 'outside', question: '指定路径不在配置的文件工作目录内，请提供工作目录内的文件路径。' });
      }
      if (!isRelativeFilePath(path)) return Object.freeze({ kind: 'revise', reason: 'path', feedback: '文件候选需要规范的工作目录相对路径，不能包含路径跳转或空路径段。' });
      if (key === 'sourcePath') paths.sourcePath = path;
      else paths.output = Object.freeze({ path });
    }
    const accepted: FileTask = paths.sourcePath !== undefined ? Object.freeze({ sourcePath: paths.sourcePath, ...(paths.output ? { output: paths.output } : {}) }) : Object.freeze({ output: paths.output! });
    return Object.freeze({ kind: 'ready', task: accepted });
  }

  private async inspectPath(operation: 'read' | 'create', path: string, signal?: AbortSignal): Promise<Exclude<FileTaskInspection, { kind: 'ready' }> | undefined> {
    try {
      requireActive(signal);
      const location = await this.locate(operation, path);
      requireActive(signal);
      let entry: Stats;
      try {
        entry = await lstat(location.target);
      } catch (error) {
        if (operation === 'create' && error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          requireActive(signal);
          return undefined;
        }
        throw error;
      }
      requireActive(signal);
      if (operation === 'create') return Object.freeze({ kind: 'needs-input', reason: 'exists', question: `输出文件 ${path} 已存在。当前能力只创建新文件，请提供另一个输出文件名。` });
      if (entry.isSymbolicLink()) throw fileFailure(operation, path, 'symbolic-link');
      if (!entry.isFile()) throw fileFailure(operation, path, 'not-file');
      if (entry.size > this.configuration.maxReadBytes) throw fileFailure(operation, path, 'too-large');
      return undefined;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        requireActive(signal);
        return Object.freeze({ kind: 'needs-input', reason: operation === 'read' ? 'source-missing' : 'directory-missing', question: operation === 'read' ? `找不到来源文件 ${path}，请确认工作目录内的文件路径。` : `输出路径 ${path} 的目录不存在或不是目录，请提供已有目录内的新文件路径。` });
      }
      if (error instanceof DeclaredException && error.contract === FileAccessException) {
        const reason = error.facts.reason;
        if (reason === 'symbolic-link' || reason === 'not-file' || reason === 'too-large' || reason === 'unavailable') {
          requireActive(signal);
          return Object.freeze({ kind: 'needs-input', reason, question: reason === 'symbolic-link' ? '指定路径包含符号链接，请提供工作目录内的普通文件路径。' : reason === 'not-file' ? '指定来源不是普通文件，请提供文本文件路径。' : reason === 'too-large' ? `来源文件超过了 ${this.configuration.maxReadBytes} 字节的读取范围，请提供更小的文本文件。` : '指定路径的目录不可用，请提供已有目录内的文件路径。' });
        }
      }
      // Permission and IO failures cannot be repaired by changing a model proposal.
      throw this.failure(operation, path, error);
    }
  }

  private async rootDirectory(operation: 'read' | 'create', path: string): Promise<DirectoryIdentity> {
    try {
      const root = await realpath(this.#root);
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory()) throw fileFailure(operation, path, 'workspace-unavailable');
      const identity = directory(root, rootStat);
      if (this.#identity && (this.#identity.path !== root || this.#identity.dev !== identity.dev || this.#identity.ino !== identity.ino)) throw fileFailure(operation, path, 'changed');
      this.#identity ??= identity;
      return identity;
    } catch (error) {
      if (error instanceof DeclaredException && error.contract === FileAccessException) throw error;
      // Root availability belongs to the environment, even if it changes after a first preflight check.
      throw fileFailure(operation, path, 'workspace-unavailable', error);
    }
  }
  private async locate(operation: 'read' | 'create', path: string): Promise<FileLocation> {
    const identity = await this.rootDirectory(operation, path);
    const root = identity.path;
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
