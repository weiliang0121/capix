import { ExecutionDefinition, defineExecution, defineChildEntry } from '@capix/server-runtime';
import type { AttemptDefinition, OperationDefinition, RuntimeWork, ExecutionWork, OperationWork, AttemptWork, AcceptWork, HandleWork, ResumeWork, InvocationRunDefinition, InvocationExceptionDefinition, InvocationCheckpointPoint, ChildReference, ChildEntryInput, ChildrenOf, DefinitionInput, DefinitionOutput } from '@capix/server-runtime';

declare const execution: ExecutionDefinition<string, number>;
declare const operation: OperationDefinition<string, number>;
declare const attempt: AttemptDefinition<string, number>;
declare function expectType<T>(value: T): void;

export function rootHelper(work: RuntimeWork<string, number>): Promise<number> {
  return work.children.create(execution, work.input).run();
}

export function executionHelper(work: ExecutionWork<string, number>): Promise<number> {
  return work.children.create(operation, work.input).run();
}

export function operationHelper(work: OperationWork<string, number>) {
  expectType<Promise<number>>(work.children.create(operation, work.input).run());
  expectType<Promise<number>>(work.children.create(attempt, work.input).run());
}

export function leafHelper(work: AttemptWork<string, number>): number {
  return work.input.length;
}

// Helpers preserve the actual child's I/O rather than falling back to an untyped union.
export function specificHelper<Definition extends ChildrenOf<'operation'>>(work: OperationWork<string, number, Record<string, never>, Definition>, child: Definition, input: DefinitionInput<Definition>) {
  expectType<Promise<DefinitionOutput<Definition>>>(work.children.create(child, input).run());
}

export class NamedExecution extends ExecutionDefinition<string, number> {
  readonly children = [operation];
  readonly run: InvocationRunDefinition<string, number, 'execution', Record<string, never>> = {
    requires: {},
    execute: executionHelper,
    accept(work) {
      expectType<Promise<number>>(work.children.create(operation, work.input).run());
      return work.delivered;
    },
  };
  readonly exceptions: InvocationExceptionDefinition<string, number, 'execution', Record<string, never>> = {
    requires: {},
    uses: [operation],
    accepts: [],
    handle(work) {
      expectType<Promise<number>>(work.children.create(operation, work.input).run());
      return work.unhandled;
    },
  };
}

export const factoryExecution = defineExecution<string, number>()({ children: [operation], run: { execute: executionHelper } });

const entry = defineChildEntry(operation, { accept: ({ input }: ChildEntryInput<number>) => String(input) });
export function stageHelpers(accept: AcceptWork<'execution', string, number>, handle: HandleWork<'execution', string, number>, resume: ResumeWork<'execution', string, number>, reference: ChildReference<typeof operation>) {
  expectType<Promise<number>>(accept.children.entry(entry, 1).run());
  expectType<Promise<number>>(handle.children.create(operation, handle.input).run());
  expectType<Promise<number>>(resume.children.resume(reference).run());
}

// No new child action rights are required to read old relations and accept a saved delivery.
export function historicalHelper(work: ResumeWork<'operation', string, number, Record<string, never>, never>, reference: ChildReference<typeof attempt>) {
  expectType<string>(work.children.facts.get(reference).input);
  expectType<string>(work.children.facts.require(attempt, reference).input);
  expectType<Promise<number>>(work.children.open(reference).accept());
}

declare const point: InvocationCheckpointPoint<string, number, 'execution', number>;
expectType<readonly ChildrenOf<'execution'>[] | undefined>(point.resume.uses);
