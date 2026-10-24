import { checkpointPoint, defineNode } from '@capix/server-runtime';
import type { ResourceRequest, CheckpointCodec, NodeWork, AcceptWork, HandleWork, ResumeWork } from '@capix/server-runtime';

interface Reader {
  read(input: string): string;
}
interface Logger {
  write(input: string): void;
}
declare const reader: ResourceRequest<Reader>;
declare const logger: ResourceRequest<Logger>;
declare const state: CheckpointCodec<number>;
const metadata = { name: 'read', label: 'Read', source: 'test', callee: 'local' };

export function read(work: NodeWork<string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
function accept(work: AcceptWork<'node', string, string, { reader: Reader }>) {
  return work.delivered;
}
function handle(work: HandleWork<'node', string, string, { logger: Logger }>) {
  work.resources.logger.write(work.exception.message);
  return work.unhandled;
}
function resume(work: ResumeWork<'node', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}

export const definition = defineNode<string, string>()({
  ...metadata,
  deps: { reader },
  run: read,
  accept,
  exceptions: { deps: { logger }, accepts: [], handle },
});
export const point = checkpointPoint<'node', string, string>()({ name: 'read', state, references: {}, resume: { deps: { reader }, run: resume } });

function emptyRun(work: NodeWork<string, string>) {
  return work.input;
}
function emptyAccept(work: AcceptWork<'node', string, string>) {
  return work.delivered;
}
function emptyHandle(work: HandleWork<'node', string, string>) {
  return work.unhandled;
}
function emptyResume(work: ResumeWork<'node', string, string>) {
  return work.input;
}

// Omitting deps means no resources, even when the function is defined separately.
export const emptyDefinition = defineNode<string, string>()({ ...metadata, run: emptyRun, accept: emptyAccept, exceptions: { accepts: [], handle: emptyHandle } });
export const emptyPoint = checkpointPoint<'node', string, string>()({ name: 'empty', state, references: {}, resume: { run: emptyResume } });
