import { checkpointPoint, defineNode } from '@weiliang0121/capix-runtime';
import type { CheckpointCodec, NodeWork, ResumeWork } from '@weiliang0121/capix-runtime';
import type { ResourceRequest } from '@weiliang0121/capix-resources';
interface Reader {
  read(input: string): string;
}
declare const reader: ResourceRequest<Reader>;
declare const state: CheckpointCodec<number>;
export function read(work: NodeWork<string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
function resume(work: ResumeWork<'node', string, string, { reader: Reader }>) {
  return work.resources.reader.read(work.input);
}
export const definition = defineNode<string, string>()({ deps: { reader }, run: read });
export const point = checkpointPoint<'node', string, string>()({ name: 'read', state, references: {}, resume: { deps: { reader }, run: resume } });
function emptyRun(work: NodeWork<string, string>) {
  return work.input;
}
function emptyResume(work: ResumeWork<'node', string, string>) {
  return work.input;
}
export const emptyDefinition = defineNode<string, string>()({ run: emptyRun });
export const emptyPoint = checkpointPoint<'node', string, string>()({ name: 'empty', state, references: {}, resume: { run: emptyResume } });
