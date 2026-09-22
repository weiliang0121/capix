import { Operation } from '../../dist/server/operations/operation.js';

// A configurable work implementation; call/lifecycle behavior is inherited unchanged.
export class TestOperation extends Operation {
  constructor(runtime, definition, phases) {
    super(runtime, definition);
    this.before = phases.before;
    this.commit = phases.commit;
    this.after = phases.after;
  }
}
