import { AttemptFixture } from './behavior.mjs';

export class TestAttempt extends AttemptFixture {
  source = 'test/fixtures/attempt.mjs · TestAttempt';
  constructor(runtime, name, work = (input) => input) {
    super(runtime.attemptInvocationBuilder);
    this.name = name;
    this.label = name;
    this.action = work;
  }

  execute(context) {
    return this.action(context.currentInput, context);
  }
}
