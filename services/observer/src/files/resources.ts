import type { FileReceipt, FileTask } from '@capix/protocol';
import { ResourceOffer, type ProgressChannel, type ResourceOperation } from '@capix/server-runtime';
import type { WorkspaceFiles } from './workspace.js';
import type { FileProgress, FileTaskInspection, TextDocument } from './types.js';
import { isRelativeFilePath } from './path.js';
import { fileFailure } from './error.js';

export interface FileResourceSource {
  readonly files: WorkspaceFiles;
  readonly constraint?: FileTask;
  readonly path?: string;
  readonly progress?: ProgressChannel<FileProgress>;
}
export interface FileReader {
  readText(path: string, signal?: AbortSignal): Promise<TextDocument>;
}
export interface FileCreator {
  createText(path: string, text: string, signal?: AbortSignal): Promise<FileReceipt>;
  createFixed(position: string, path: string, text: string, signal?: AbortSignal): Promise<FileReceipt>;
}
export type FileInspector = ReturnType<typeof FileResources.inspect.request> extends import('@capix/server-runtime').ResourceRequest<infer Value> ? Value : never;
export function documentDescriptor(document: TextDocument): FileReceipt {
  return Object.freeze({ path: document.path, bytes: document.bytes, digest: document.digest });
}
export const FileResources = Object.freeze({
  inspect: new ResourceOffer({
    name: 'workspace-files.inspect',
    methods: {
      inspect(source: FileResourceSource, task: FileTask, operation: ResourceOperation): Promise<FileTaskInspection> {
        return source.files.checkTask(task, { signal: operation.signal, constraint: source.constraint });
      },
    },
    observation: {
      source: (source) => ({ constraint: source.constraint ?? null, maxReadBytes: source.files.configuration.maxReadBytes, overwrite: false }),
      methods: { inspect: { input: (task) => ({ task }), output: (result) => result } },
    },
  }),
  readText: new ResourceOffer<FileResourceSource, FileReader, FileResourceSource, string>(
    'workspace-files.read-text',
    (source, activity) =>
      Object.freeze({
        readText: (path: string, signal?: AbortSignal) =>
          activity.runAsync('read-text', { input: () => ({ path }), output: documentDescriptor }, () => {
            if (path !== source.path) throw fileFailure('read', path, 'not-allowed');
            return source.files.readText(path, signal);
          }),
      }),
    'access',
    { describe: (source) => ({ path: source.path ?? null, maxBytes: source.files.configuration.maxReadBytes }), refine: (source, path) => refineFileSource(source, path, 'read') },
  ),
  createText: new ResourceOffer<FileResourceSource, FileCreator, FileResourceSource, string>(
    'workspace-files.create-text',
    (source, activity) =>
      Object.freeze({
        createFixed: (position: string, path: string, text: string, signal?: AbortSignal) =>
          activity.runAsync('create-fixed', { input: () => ({ position, path, bytes: Buffer.byteLength(text, 'utf8') }), output: (receipt) => receipt }, () => {
            if (path !== source.path) throw fileFailure('create', path, 'not-allowed');
            if (!activity.origin) throw new Error('Fixed file creation requires a calling identity');
            return source.files.createFixed({ contextId: activity.origin.contextId, position }, path, text, { signal, progress: source.progress });
          }),
        createText: (path: string, text: string, signal?: AbortSignal) =>
          activity.runAsync('create-text', { input: () => ({ path, bytes: Buffer.byteLength(text, 'utf8') }), output: (receipt) => receipt }, () => {
            if (path !== source.path) throw fileFailure('create', path, 'not-allowed');
            return source.files.createText(path, text, { signal, progress: source.progress });
          }),
      }),
    'access',
    { describe: (source) => ({ path: source.path ?? null, maxBytes: source.files.configuration.maxWriteBytes }), refine: (source, path) => refineFileSource(source, path, 'create') },
  ),
});

function refineFileSource(source: FileResourceSource, path: string, operation: 'read' | 'create'): FileResourceSource {
  const constrained = operation === 'read' ? source.constraint?.sourcePath : source.constraint?.output?.path;
  if (!isRelativeFilePath(path) || (source.path !== undefined && source.path !== path) || (source.constraint !== undefined && constrained !== path)) throw fileFailure(operation, path, 'not-allowed');
  return Object.freeze({ ...source, path });
}
