import { randomUUID } from 'node:crypto';
import { captureSource } from './observer.mjs';
import { ResourceBindings } from '@capix-observer/runtime';

// Low-level mechanism fixtures deliberately retain actual Context/Invocation access.
// Business definitions are separately verified through assembleRuntime's restricted views.
function work(owner) {
  return {
    maxRounds: owner.maxRounds ?? 1,
    execute: (context, invocation) => owner.execute(context, invocation),
    raises: owner.raises,
    exceptions: owner.exceptions,
    ...(owner.accept ? { accept: (context, output, invocation) => owner.accept(context, output, invocation) } : {}),
  };
}
export class Execution {
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
      requires: this.requires ?? {},
      work: work(this),
      establish: () => ({ resources: this.resourceBinding?.(captureSource(options)) ?? new ResourceBindings({}) }),
    });
  }
}
export class Operation {
  id = randomUUID();
  constructor(builder) {
    this.builder = builder;
  }
  create(parent, input, options = {}) {
    return this.builder.create(parent, { input, requires: this.requires ?? {}, description: { id: this.id, name: this.name, label: this.label, source: this.source }, work: work(this), key: options.key });
  }
  async call(parent, input) {
    return this.create(parent, input).run();
  }
}
export class Attempt {
  constructor(builder, requires = {}) {
    this.builder = builder;
    this.requires = requires;
  }
  create(parent, input, options = {}) {
    return this.builder.create(parent, { input, requires: this.requires, description: this, work: work(this), key: options.key });
  }
  async call(parent, input) {
    return this.create(parent, input).run();
  }
}
