import type { FileReceipt, FileTask } from '@capix/protocol';
import { type ProgressChannel } from '@capix/changes';
import { ResourceOffer, type ResourceEndpointActivity, type ResourceOperation, type ResourceRequest } from '@capix/resources';
import { type OperationOptions, type OperationResult } from '@capix/resources/operation';
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
export type FileReader = ReturnType<typeof FileResources.readText.request> extends ResourceRequest<infer Value> ? Value : never;
type FileCreationOptions = OperationOptions<FileReceipt, unknown, unknown> & { readonly signal?: AbortSignal };
export interface FileCreator {
  createText<const Options extends FileCreationOptions = {}>(path: string, text: string, options?: Options): Promise<OperationResult<FileReceipt, Options>>;
  createFixed<const Options extends FileCreationOptions = {}>(position: string, path: string, text: string, options?: Options): Promise<OperationResult<FileReceipt, Options>>;
}
export type FileInspector = ReturnType<typeof FileResources.inspect.request> extends ResourceRequest<infer Value> ? Value : never;
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
  readText: new ResourceOffer({
    name: 'workspace-files.read-text',
    methods: {
      readText(source: FileResourceSource, path: string, operation: ResourceOperation): Promise<TextDocument> {
        if (path !== source.path) throw fileFailure('read', path, 'not-allowed');
        return source.files.readText(path, operation.signal);
      },
    },
    refine: (source, path: string) => refineFileSource(source, path, 'read'),
    observation: {
      source: (source) => ({ path: source.path ?? null, maxBytes: source.files.configuration.maxReadBytes }),
      methods: { readText: { input: (path) => ({ path }), output: documentDescriptor } },
    },
  }),
  createText: new ResourceOffer({
    name: 'workspace-files.create-text',
    expose: exposeFileCreator,
    describe: (source) => ({ path: source.path ?? null, maxBytes: source.files.configuration.maxWriteBytes }),
    refine: (source, path: string) => refineFileSource(source, path, 'create'),
  }),
});

/** Fixed writes need the calling identity as well as the ordinary resource-operation boundary. */
function exposeFileCreator(source: FileResourceSource, activity: ResourceEndpointActivity): FileCreator {
  return Object.freeze<FileCreator>({
    createFixed: (position, path, text, options) =>
      activity.operate(
        'create-fixed',
        { input: () => ({ position, path, bytes: Buffer.byteLength(text, 'utf8') }), output: (receipt: FileReceipt) => receipt },
        (operation) => {
          if (path !== source.path) throw fileFailure('create', path, 'not-allowed');
          if (!activity.origin) throw new Error('Fixed file creation requires a calling identity');
          return source.files.createFixed({ contextId: activity.origin.contextId, position }, path, text, { signal: operation.signal ?? options?.signal, progress: source.progress });
        },
        options,
      ),
    createText: (path, text, options) =>
      activity.operate(
        'create-text',
        { input: () => ({ path, bytes: Buffer.byteLength(text, 'utf8') }), output: (receipt: FileReceipt) => receipt },
        (operation) => {
          if (path !== source.path) throw fileFailure('create', path, 'not-allowed');
          return source.files.createText(path, text, { signal: operation.signal ?? options?.signal, progress: source.progress });
        },
        options,
      ),
  });
}

function refineFileSource(source: FileResourceSource, path: string, operation: 'read' | 'create'): FileResourceSource {
  const constrained = operation === 'read' ? source.constraint?.sourcePath : source.constraint?.output?.path;
  if (!isRelativeFilePath(path) || (source.path !== undefined && source.path !== path) || (source.constraint !== undefined && constrained !== path)) throw fileFailure(operation, path, 'not-allowed');
  return Object.freeze({ ...source, path });
}
