import type { Stable } from '@capix/contracts';
import { Group, defineGroup } from '@capix/server-runtime';
import type { Node, SceneWork, GroupWork, NodeWork, ResumeWork, CallableRun, InvocationCheckpointPoint, ChildReference, ChildrenOf, CallableInput, CallableOutput } from '@capix/server-runtime';
declare const operation: Group<string, number>;
declare const node: Node<string, number>;
declare function expectType<T>(value: T): void;
export function rootHelper(work: SceneWork<string, number>): Promise<number> {
  return work.children.invoke(operation, work.input);
}
export function groupHelper(work: GroupWork<string, number>) {
  expectType<Promise<number>>(work.children.invoke(operation, work.input));
  return work.children.invoke(node, work.input);
}
export function leafHelper(work: NodeWork<string, number>): number {
  return work.input.length;
}
export function specificHelper<Definition extends ChildrenOf<'group'>>(work: GroupWork<string, number, Record<string, never>, Definition>, child: Definition, input: CallableInput<Definition>) {
  expectType<Promise<Stable<CallableOutput<Definition>>>>(work.children.invoke(child, input));
}
export class NamedGroup extends Group<string, number> {
  constructor() {
    super();
    this.add(operation);
  }
  readonly run: CallableRun<string, number, 'group', Record<string, never>> = groupHelper;
}
export const factory = defineGroup<string, number>()({ members: [operation], run: rootHelper });
const prepareInput = (input: number) => String(input);
export function recovery(work: ResumeWork<'group', string, number>, reference: ChildReference<typeof operation>) {
  expectType<Promise<number>>(work.children.invoke(operation, prepareInput(1)));
  expectType<Promise<number>>(work.children.resume(reference).invoke());
}
export function historical(work: ResumeWork<'group', string, number, Record<string, never>, never>, reference: ChildReference<typeof node>) {
  expectType<string>(work.children.facts.get(reference).input);
  expectType<Promise<number>>(work.children.open(reference).invoke());
}
declare const point: InvocationCheckpointPoint<string, number, 'group', number>;
expectType<readonly ChildrenOf<'group'>[] | undefined>(point.resume.uses);
