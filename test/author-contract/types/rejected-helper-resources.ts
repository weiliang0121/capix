import { checkpointPoint, defineNode } from '@capix/server-runtime';
import type { ResourceRequest, CheckpointCodec, NodeWork, AcceptWork, HandleWork, ResumeWork } from '@capix/server-runtime';

interface Reader {
  read(input: string): string;
}
interface Writer {
  write(input: string): void;
}
declare const writer: ResourceRequest<Writer>;
declare const state: CheckpointCodec<number>;
const metadata = { name: 'read', label: 'Read', source: 'test', callee: 'local' };

function read(work: NodeWork<string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
function accept(work: AcceptWork<'node', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.delivered);
}
function handle(work: HandleWork<'node', string, string, { reader: Reader }>) {
  return work.return(work.resources.reader.read(work.input));
}
function resume(work: ResumeWork<'node', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}

// A helper cannot create an implicit request or substitute a different resource contract.
defineNode<string, string>()({ ...metadata, run: { execute: read } });
defineNode<string, string>()({ ...metadata, run: { requires: { reader: writer }, execute: read } });
defineNode<string, string>()({ ...metadata, run: { execute: (work) => work.input, accept } });
defineNode<string, string>()({ ...metadata, run: { execute: (work) => work.input }, exceptions: { accepts: [], handle } });
checkpointPoint<'node', string, string>()({ name: 'read', state, references: {}, resume: { execute: resume } });
