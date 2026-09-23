import { Operation } from '../../dist/server/operations/operation.js';

// A configurable work implementation; call/lifecycle behavior is inherited unchanged.
export class TestOperation extends Operation {
  name = 'test';
  label = 'test';
  source = 'test/fixtures/operation.mjs · TestOperation';
  phaseSource = 'test/fixtures/operation.mjs';

  constructor(runtime, phases = { before: (input) => input, commit: (input) => input, after: (input) => input }) {
    super(runtime);
    this.before = phases.before;
    this.commit = phases.commit;
    this.after = phases.after;
  }
}
