import { Group, defineGroup, defineChildEntry } from '@capix/server-runtime';
import type { Node, Scene, SceneWork, GroupWork, NodeWork, AcceptWork, HandleWork, ResumeWork, InvocationRunDefinition, InvocationExceptionDefinition, InvocationCheckpointPoint, ChildReference, ChildEntryInput } from '@capix/server-runtime';

declare const scene: Scene<string, number>;
declare const execution: Group<string, number>;
declare const operation: Group<string, number>;
declare const attempt: Node<string, number>;
declare const rootWork: SceneWork<string, number>;
declare const executionWork: GroupWork<string, number>;
declare const operationWork: GroupWork<string, number>;
declare const attemptWork: NodeWork<string, number>;
declare const acceptWork: AcceptWork<'group', string, number>;
declare const handleWork: HandleWork<'group', string, number>;
declare const resumeWork: ResumeWork<'group', string, number>;
declare const sceneReference: ChildReference<typeof scene>;
declare const leafReference: ChildReference<typeof attempt>;

rootWork.children.create(scene, 'input');
executionWork.children.create(scene, 'input');
operationWork.children.create(scene, 'input');
attemptWork.children;
acceptWork.children.create(scene, 'input');
handleWork.children.create(scene, 'input');
resumeWork.children.resume(sceneReference);
executionWork.children.entry(defineChildEntry(scene, { accept: ({ input }: ChildEntryInput<number>) => String(input) }), 1);

type InvalidWork = GroupWork<string, number, Record<string, never>, typeof scene>;
type InvalidRun = InvocationRunDefinition<string, number, 'group', Record<string, never>, never, typeof scene>;
type InvalidException = InvocationExceptionDefinition<string, number, 'group', Record<string, never>, typeof scene>;
type InvalidPoint = InvocationCheckpointPoint<string, number, 'group', number, Record<string, never>, Record<string, never>, typeof scene>;

class InvalidExecution extends Group<string, number> {
  constructor() {
    super();
    this.add(operation);
  }
  readonly run: InvocationRunDefinition<string, number, 'group', Record<string, never>, never, typeof operation> = {
    deps: {},
    execute(work) {
      work.children.create(attempt, work.input);
      return 0;
    },
  };
}

defineGroup<string, number>()({ members: [operation], run: (work) => work.children.create(attempt, work.input).run() });

// A narrowed stage cannot acquire actions just because its owner registered another child.
defineGroup<string, number>()({
  members: [operation],
  uses: [],
  run(work) {
    work.children.create(operation, work.input);
    return 0;
  },
});
