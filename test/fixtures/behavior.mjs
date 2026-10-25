import { ResourceBindings } from './resources.mjs';
import { randomUUID } from 'node:crypto';
import { captureSource } from './observer.mjs';

// Low-level mechanism fixtures deliberately retain actual Context/Invocation access.
// Business definitions are separately verified through installCallable's restricted views.
function work(owner) {
  return { execute: (context, invocation) => owner.execute(context, invocation) };
}

export class ExecutionFixture {
  constructor(builder) {
    this.builder = builder;
  }
  call(input, options, started) {
    return this.submit(() => input, options, started);
  }
  submit(accept, options, started) {
    return this.builder.submit(accept, {
      context: options,
      started,
      deps: this.deps ?? {},
      work: work(this),
      establish: () => ({ resources: this.resourceBinding?.(captureSource(options)) ?? new ResourceBindings({}) }),
    });
  }
}
export class OperationFixture {
  id = randomUUID();
  constructor(builder) {
    this.builder = builder;
  }
  create(parent, input, options = {}) {
    return this.builder.create(parent, { input, deps: this.deps ?? {}, description: { id: this.id, name: this.name, label: this.label, source: this.source }, work: work(this), key: options.key });
  }
  async call(parent, input) {
    return this.create(parent, input).run();
  }
}
export class AttemptFixture {
  constructor(builder, deps = {}) {
    this.builder = builder;
    this.deps = deps;
  }
  create(parent, input, options = {}) {
    return this.builder.create(parent, { input, deps: this.deps, description: this, work: work(this), key: options.key });
  }
  async call(parent, input) {
    return this.create(parent, input).run();
  }
}
