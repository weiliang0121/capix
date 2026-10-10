import { OperationFixture } from './behavior.mjs';
import { callFor, rememberCall } from './lifecycle.mjs';
import { TestAttempt } from './attempt.mjs';

// Variable-length composition used only by tests; production operations own their execute methods.
export class TestOperation extends OperationFixture {
  name = 'test';
  label = 'test';
  source = 'test/fixtures/operation.mjs · TestOperation';

  constructor(runtime, actions = { identity: (input) => input }) {
    super(runtime.operationInvocationBuilder);
    this.actions = Object.entries(actions).map(([name, work]) => new TestAttempt(runtime, name, work));
  }

  async execute(context, invocation) {
    rememberCall(invocation);
    let value = context.currentInput;
    for (const action of this.actions) value = await action.call(invocation, value);
    return value;
  }
}
