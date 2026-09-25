import { Attempt } from '../../dist/server/attempt/attempt.js';

export class TestAttempt extends Attempt {
  source = 'test/fixtures/attempt.mjs · TestAttempt';
  callee = 'processing';

  constructor(runtime, name, work = (input) => input) {
    super(runtime);
    this.name = name;
    this.label = name;
    this.work = work;
  }

  execute(context) {
    return this.work(context.input, context);
  }
}
