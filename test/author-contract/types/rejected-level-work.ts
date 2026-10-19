import { ExecutionDefinition, defineExecution, defineChildEntry } from '@capix/server-runtime';
import type { AttemptDefinition, OperationDefinition, RuntimeWork, ExecutionWork, OperationWork, AttemptWork, AcceptWork, HandleWork, ResumeWork, InvocationRunDefinition, InvocationExceptionDefinition, InvocationCheckpointPoint, ChildReference, ChildEntryInput } from '@capix/server-runtime';

declare const execution: ExecutionDefinition<string, number>;
declare const operation: OperationDefinition<string, number>;
declare const attempt: AttemptDefinition<string, number>;
declare const rootWork: RuntimeWork<string, number>;
declare const executionWork: ExecutionWork<string, number>;
declare const operationWork: OperationWork<string, number>;
declare const attemptWork: AttemptWork<string, number>;
declare const acceptWork: AcceptWork<'execution', string, number>;
declare const handleWork: HandleWork<'execution', string, number>;
declare const resumeWork: ResumeWork<'execution', string, number>;
declare const leafReference: ChildReference<typeof attempt>;

rootWork.children.create(operation, 'input');
executionWork.children.create(attempt, 'input');
operationWork.children.create(execution, 'input');
attemptWork.children;
acceptWork.children.create(attempt, 'input');
handleWork.children.create(attempt, 'input');
resumeWork.children.resume(leafReference);
executionWork.children.entry(defineChildEntry(attempt, { accept: ({ input }: ChildEntryInput<number>) => String(input) }), 1);

type InvalidWork = ExecutionWork<string, number, Record<string, never>, typeof attempt>;
type InvalidRun = InvocationRunDefinition<string, number, 'execution', Record<string, never>, never, typeof attempt>;
type InvalidException = InvocationExceptionDefinition<string, number, 'execution', Record<string, never>, typeof attempt>;
type InvalidPoint = InvocationCheckpointPoint<string, number, 'execution', number, Record<string, never>, Record<string, never>, typeof attempt>;

class InvalidExecution extends ExecutionDefinition<string, number> {
  readonly children = [operation];
  readonly run: InvocationRunDefinition<string, number, 'execution', Record<string, never>> = {
    requires: {},
    execute(work) {
      work.children.create(attempt, work.input);
      return 0;
    },
  };
}

defineExecution<string, number>()({ children: [operation], run: { execute: (work) => work.children.create(attempt, work.input).run() } });

// A narrowed stage cannot acquire actions just because its owner registered another child.
defineExecution<string, number>()({
  children: [operation],
  run: {
    uses: [],
    execute(work) {
      work.children.create(operation, work.input);
      return 0;
    },
  },
});
