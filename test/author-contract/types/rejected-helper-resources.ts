import { checkpointPoint, defineNode } from '@weiliang0121/capix-runtime';
import type { CheckpointCodec, NodeWork, ResumeWork } from '@weiliang0121/capix-runtime';
import type { ResourceRequest } from '@weiliang0121/capix-resources';
interface Reader {
  read(input: string): string;
}
interface Writer {
  write(input: string): void;
}
declare const writer: ResourceRequest<Writer>;
declare const state: CheckpointCodec<number>;
function read(work: NodeWork<string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
function resume(work: ResumeWork<'node', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
defineNode<string, string>()({ run: read });
defineNode<string, string>()({ deps: { reader: writer }, run: read });
checkpointPoint<'node', string, string>()({ name: 'read', state, references: {}, resume: { run: resume } });
