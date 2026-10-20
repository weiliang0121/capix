import { Group, defineGroup, defineChildEntry } from '@capix/server-runtime';
import type { Node, Scene, SceneWork, GroupWork, NodeWork, AcceptWork, HandleWork, ResumeWork, InvocationRunDefinition, InvocationExceptionDefinition, InvocationCheckpointPoint, ChildReference, ChildEntryInput, ChildrenOf, CallableInput, CallableOutput } from '@capix/server-runtime';

declare const execution: Group<string, number>;
declare const operation: Group<string, number>;
declare const attempt: Node<string, number>;
declare function expectType<T>(value: T): void;

export function rootHelper(work: SceneWork<string, number>): Promise<number> {
  return work.children.create(execution, work.input).run();
}

export function executionHelper(work: GroupWork<string, number>): Promise<number> {
  return work.children.create(operation, work.input).run();
}

export function operationHelper(work: GroupWork<string, number>) {
  expectType<Promise<number>>(work.children.create(operation, work.input).run());
  expectType<Promise<number>>(work.children.create(attempt, work.input).run());
}

export function leafHelper(work: NodeWork<string, number>): number {
  return work.input.length;
}

// Helpers preserve the actual child's I/O rather than falling back to an untyped union.
export function specificHelper<Definition extends ChildrenOf<'group'>>(work: GroupWork<string, number, Record<string, never>, Definition>, child: Definition, input: CallableInput<Definition>) {
  expectType<Promise<CallableOutput<Definition>>>(work.children.create(child, input).run());
}

export class NamedExecution extends Group<string, number> {
  readonly members = [operation];
  readonly run: InvocationRunDefinition<string, number, 'group', Record<string, never>> = {
    requires: {},
    execute: executionHelper,
    accept(work) {
      expectType<Promise<number>>(work.children.create(operation, work.input).run());
      return work.delivered;
    },
  };
  readonly exceptions: InvocationExceptionDefinition<string, number, 'group', Record<string, never>> = {
    requires: {},
    uses: [operation],
    accepts: [],
    handle(work) {
      expectType<Promise<number>>(work.children.create(operation, work.input).run());
      return work.unhandled;
    },
  };
}

export const factoryExecution = defineGroup<string, number>()({ members: [operation], run: { execute: executionHelper } });

const entry = defineChildEntry(operation, { accept: ({ input }: ChildEntryInput<number>) => String(input) });
export function stageHelpers(accept: AcceptWork<'group', string, number>, handle: HandleWork<'group', string, number>, resume: ResumeWork<'group', string, number>, reference: ChildReference<typeof operation>) {
  expectType<Promise<number>>(accept.children.entry(entry, 1).run());
  expectType<Promise<number>>(handle.children.create(operation, handle.input).run());
  expectType<Promise<number>>(resume.children.resume(reference).run());
}

// No new child action rights are required to read old relations and accept a saved delivery.
export function historicalHelper(work: ResumeWork<'group', string, number, Record<string, never>, never>, reference: ChildReference<typeof attempt>) {
  expectType<string>(work.children.facts.get(reference).input);
  expectType<string>(work.children.facts.require(attempt, reference).input);
  expectType<Promise<number>>(work.children.open(reference).accept());
}

declare const point: InvocationCheckpointPoint<string, number, 'group', number>;
expectType<readonly ChildrenOf<'group'>[] | undefined>(point.resume.uses);
