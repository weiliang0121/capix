import { AttemptDefinition, OperationDefinition, type AttemptContextView, type OperationContextView, type InvocationWorkView, type InvocationView, type ChildBindings, type OutputDeclaration } from '@capix/server-runtime';

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
class Leaf extends AttemptDefinition<string, string, Record<string, never>, Record<string, never>, string> {
  name = 'leaf';
  label = 'Leaf';
  source = 'test';
  callee = 'test';
  readonly output = text;
  readonly run = {
    requires: {},
    execute(context: AttemptContextView<string, string>, invocation: InvocationWorkView<string, string, AttemptContextView<string, string>, string>) {
      invocation.output.emit(context.input);
      // @ts-expect-error only declared string deltas may be emitted
      invocation.output.emit(42);
      return context.input;
    },
    accept(_context: AttemptContextView<string, string>, result: string, invocation: InvocationView<string, string, AttemptContextView<string, string>>) {
      // @ts-expect-error reception does not own a writer
      invocation.output.emit('late');
      return result;
    },
  };
}
class Parent extends OperationDefinition<string, string, Record<string, never>, Record<string, never>, string> {
  name = 'parent';
  label = 'Parent';
  source = 'test';
  readonly leaf = new Leaf();
  readonly children = [this.leaf];
  readonly output = text;
  readonly run = {
    requires: {},
    execute: async (context: OperationContextView<string, string>, invocation: InvocationWorkView<string, string, OperationContextView<string, string>, string>, children: ChildBindings) => {
      const call = children.get(this.leaf).create(invocation, context.input, {
        output: {
          receive(event) {
            if (event.kind === 'delta') {
              const value: string = event.delta;
              invocation.output.emit(value);
            }
          },
        },
      });
      // @ts-expect-error child views do not have producing endpoints
      call.output.emit('borrow');
      return call.run();
    },
  };
}
void new Parent();
declare const typed: AttemptDefinition<string, string, Record<string, never>, Record<string, never>, string>;
declare const owner: InvocationView<unknown, unknown, OperationContextView>;
declare const children: ChildBindings;
children.get(typed).create(owner, 'input', {
  output: {
    receive(event) {
      if (event.kind === 'delta') {
        const value: string = event.delta;
        void value;
      }
    },
  },
});
