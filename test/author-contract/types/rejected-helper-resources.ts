import { checkpointPoint, defineAttempt } from '@capix/server-runtime';
import type { ResourceRequest, CheckpointCodec, AttemptWork, AcceptWork, HandleWork, ResumeWork } from '@capix/server-runtime';

interface Reader {
  read(input: string): string;
}
interface Writer {
  write(input: string): void;
}
declare const writer: ResourceRequest<Writer>;
declare const state: CheckpointCodec<number>;
const metadata = { name: 'read', label: 'Read', source: 'test', callee: 'local' };

function read(work: AttemptWork<string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
function accept(work: AcceptWork<'attempt', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.delivered);
}
function handle(work: HandleWork<'attempt', string, string, { reader: Reader }>) {
  return work.return(work.resources.reader.read(work.input));
}
function resume(work: ResumeWork<'attempt', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}

// A helper cannot create an implicit request or substitute a different resource contract.
defineAttempt<string, string>()({ ...metadata, run: { execute: read } });
defineAttempt<string, string>()({ ...metadata, run: { requires: { reader: writer }, execute: read } });
defineAttempt<string, string>()({ ...metadata, run: { execute: (work) => work.input, accept } });
defineAttempt<string, string>()({ ...metadata, run: { execute: (work) => work.input }, exceptions: { accepts: [], handle } });
checkpointPoint<'attempt', string, string>()({ name: 'read', state, references: {}, resume: { execute: resume } });
