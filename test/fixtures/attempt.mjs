import { Attempt } from '@capix-observer/runtime';

export class TestAttempt extends Attempt {
  source = 'test/fixtures/attempt.mjs · TestAttempt';
  callee = 'processing';

  constructor(runtime, name, work = (input) => input) {
    super(runtime.attemptInvocations);
    this.name = name;
    this.label = name;
    this.action = work;
  }

  execute(context) {
    return this.action(context.currentInput, context);
  }
}
