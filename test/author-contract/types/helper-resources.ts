import { checkpointPoint, defineAttempt } from '@capix/server-runtime';
import type { ResourceRequest, CheckpointCodec, AttemptWork, AcceptWork, HandleWork, ResumeWork } from '@capix/server-runtime';

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

export function read(work: AttemptWork<string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
function accept(work: AcceptWork<'attempt', string, string, { reader: Reader }>) {
  return work.delivered;
}
function handle(work: HandleWork<'attempt', string, string, { logger: Logger }>) {
  work.resources.logger.write(work.exception.message);
  return work.unhandled;
}
function resume(work: ResumeWork<'attempt', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}

export const definition = defineAttempt<string, string>()({
  ...metadata,
  run: { requires: { reader }, execute: read, accept },
  exceptions: { requires: { logger }, accepts: [], handle },
});
export const point = checkpointPoint<'attempt', string, string>()({ name: 'read', state, references: {}, resume: { requires: { reader }, execute: resume } });

function emptyRun(work: AttemptWork<string, string>) {
  return work.input;
}
function emptyAccept(work: AcceptWork<'attempt', string, string>) {
  return work.delivered;
}
function emptyHandle(work: HandleWork<'attempt', string, string>) {
  return work.unhandled;
}
function emptyResume(work: ResumeWork<'attempt', string, string>) {
  return work.input;
}

// Omitting requires means no resources, even when the function is defined separately.
export const emptyDefinition = defineAttempt<string, string>()({ ...metadata, run: { execute: emptyRun, accept: emptyAccept }, exceptions: { accepts: [], handle: emptyHandle } });
export const emptyPoint = checkpointPoint<'attempt', string, string>()({ name: 'empty', state, references: {}, resume: { execute: emptyResume } });
