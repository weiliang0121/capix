import { Operation } from '../../dist/server/operations/operation.js';
import { TestAttempt } from './attempt.mjs';

// Variable-length composition used only by tests; production operations own their execute methods.
export class TestOperation extends Operation {
  name = 'test';
  label = 'test';
  source = 'test/fixtures/operation.mjs · TestOperation';

  constructor(runtime, actions = { identity: (input) => input }) {
    super(runtime);
    this.actions = Object.entries(actions).map(([name, work]) => new TestAttempt(runtime, name, work));
  }

  async execute(context) {
    let value = context.currentInput;
    for (const action of this.actions) value = await action.call(context, value);
    return value;
  }
}
