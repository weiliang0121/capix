import { NodeDefinition, GroupDefinition, type NodeWork, type GroupWork, type AcceptWork, type ChildCalls, type OutputDeclaration } from '@capix/server-runtime';

const text: OutputDeclaration<string, string> = {
  result(value) {
    if (typeof value !== 'string') throw new Error('text');
    return value;
  },
  delta(value) {
    if (typeof value !== 'string') throw new Error('text');
    return value;
  },
};
class Leaf extends NodeDefinition<string, string, Record<string, never>, Record<string, never>, string> {
  name = 'leaf';
  label = 'Leaf';
  source = 'test';
  callee = 'test';
  readonly output = text;
  readonly run = {
    requires: {},
    execute(work: NodeWork<string, string, Record<string, never>, string>) {
      work.output.emit(work.input);
      // @ts-expect-error only declared string deltas may be emitted
      work.output.emit(42);
      return work.input;
    },
    accept(work: AcceptWork<'node', string, string, Record<string, never>>) {
      // @ts-expect-error reception does not own a writer
      work.output.emit('late');
      return work.delivered;
    },
  };
}
class Parent extends GroupDefinition<string, string, Record<string, never>, Record<string, never>, string> {
  name = 'parent';
  label = 'Parent';
  source = 'test';
  readonly leaf = new Leaf();
  readonly members = [this.leaf];
  readonly output = text;
  readonly run = {
    requires: {},
    execute: async (work: GroupWork<string, string, Record<string, never>, Leaf, string>) => {
      const call = work.children.create(this.leaf, work.input, {
        output: {
          receive(event) {
            if (event.kind === 'delta') {
              const value: string = event.delta;
              work.output.emit(value);
            }
          },
        },
      });
      // @ts-expect-error child calls do not have producing endpoints
      call.output.emit('borrow');
      await call.run();
      return call.accept();
    },
  };
}
void new Parent();
declare const typed: NodeDefinition<string, string, Record<string, never>, Record<string, never>, string>;
declare const children: ChildCalls<typeof typed>;
children.create(typed, 'input', {
  output: {
    receive(event) {
      if (event.kind === 'delta') {
        const value: string = event.delta;
        void value;
      }
    },
  },
});
