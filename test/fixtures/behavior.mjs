import { captureSource } from './observer.mjs';
import { ResourceBindings } from '@capix-observer/runtime';
// Test-only conveniences for lifecycle scenarios. All calls use the fixed production structures.
import { Execution as ExecutionStructure, Operation as OperationStructure, Attempt as AttemptStructure, BoundChildren, OperationBinding, AttemptBinding } from '@capix-observer/runtime';

const empty = () =>
  new BoundChildren([], () => {
    throw new Error('No declared child');
  });
function definition(owner, level) {
  return {
    level,
    get requires() {
      return owner.requires ?? {};
    },
    get maxRounds() {
      return owner.maxRounds ?? 1;
    },
    get name() {
      return owner.name;
    },
    get label() {
      return owner.label;
    },
    get source() {
      return owner.source;
    },
    get callee() {
      return owner.callee;
    },
    children: [],
    execute: (context, invocation, children) => owner.execute(context, invocation, children),
    ...(owner.receive ? { receive: (context, result, invocation, children) => owner.receive(context, result, invocation, children) } : {}),
  };
}
export class Execution {
  constructor(builder) {
    this.structure = new ExecutionStructure(builder);
  }
  call(input, options, started) {
    return this.submit(() => input, options, started);
  }
  submit(accept, options, started) {
    return this.structure.submit(accept, {
      context: options,
      started,
      requires: this.requires ?? {},
      work: { maxRounds: this.maxRounds ?? 1, execute: (ctx, invocation) => this.execute(ctx, invocation), ...(this.receive ? { receive: (ctx, result, invocation) => this.receive(ctx, result, invocation) } : {}) },
      establish: () => {
        const source = captureSource(options);
        return { resources: this.resourceBinding?.(source) ?? new ResourceBindings({}), record: source };
      },
    });
  }
}
export class Operation {
  constructor(builder) {
    this.structure = new OperationBinding(new OperationStructure(builder), definition(this, 'operation'), empty());
  }
  get id() {
    return this.structure.id;
  }
  create(parent, input, options) {
    return this.structure.create(parent, input, options);
  }
  call(parent, input) {
    return this.structure.call(parent, input);
  }
}
export class Attempt {
  constructor(builder, requires = {}) {
    this.requires = requires;
    this.structure = new AttemptBinding(new AttemptStructure(builder), definition(this, 'attempt'), empty());
  }
  create(parent, input, options) {
    return this.structure.create(parent, input, options);
  }
  call(parent, input) {
    return this.structure.call(parent, input);
  }
}
