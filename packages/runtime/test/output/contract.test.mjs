import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindCallSource, Scene, Group, Node } from '@weiliang0121/capix-runtime';
import { ExceptionContract, Invocation, InvocationContext } from '@weiliang0121/capix-invocation';

const contract = {
  result(value) {
    if (typeof value !== 'string') throw new Error('string final required');
    return value;
  },
  delta(value) {
    if (typeof value !== 'string') throw new Error('string delta required');
    return value;
  },
};
const make = (work, options = {}) => new Invocation({ context: new InvocationContext('input'), signal: new AbortController().signal, work: { output: contract, ...work }, ...options });

test('declared output preserves final IO and installs terminal state before delivery', async () => {
  const events = [];
  const call = make(
    {
      execute(_context, invocation) {
        invocation.outputWriter.emit('pre');
        return 'prefix';
      },
    },
    {
      output: {
        receive(event) {
          events.push(event);
          if (event.kind === 'completed') assert.equal(call.context.status, 'succeeded');
        },
      },
    },
  );
  assert.equal(await call.run(), 'prefix');
  assert.deepEqual(
    events.map((event) => event.kind),
    ['started', 'delta', 'sealed', 'completed'],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4],
  );
  assert.ok(events.every((event) => event.contextId === call.context.id && event.round === 1));
  assert.equal(events.at(-1).result, 'prefix');
});

test('a microtask queued by sealing sees the returned execute result before final delivery', async () => {
  const checked = Promise.withResolvers();
  const call = make(
    { execute: () => 'work result' },
    {
      output: {
        receive(event) {
          if (event.kind === 'sealed') queueMicrotask(() => checked.resolve({ phase: call.context.progress.phase, result: call.context.progress.result }));
        },
      },
    },
  );
  assert.equal(await call.run(), 'work result');
  const state = await checked.promise;
  assert.equal(state.phase, 'execute');
  assert.deepEqual(state.result, { status: 'succeeded', output: 'work result' });
});

test('each independent call receives a different writer and completed writers stay sealed', async () => {
  const events = [],
    writers = [];
  const work = {
    execute(_context, invocation) {
      writers.push(invocation.outputWriter);
      invocation.outputWriter.emit(String(writers.length));
      return 'final';
    },
  };
  const first = make(work, {
    output: {
      receive: (event) => {
        events.push(event);
      },
    },
  });
  assert.equal(await first.run(), 'final');
  const second = make(work, {
    output: {
      receive: (event) => {
        events.push(event);
      },
    },
  });
  assert.equal(await second.run(), 'final');
  assert.notEqual(writers[0], writers[1]);
  for (const writer of writers) assert.throws(() => writer.emit('late'), { code: 'OUTPUT_CLOSED' });
  assert.deepEqual(
    events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['1', '2'],
  );
});

for (const domain of [false, true]) {
  test(`a ${domain ? 'domain' : 'regular'} failure discards its own candidate without a final completion`, async () => {
    const error = domain ? new ExceptionContract('OUTPUT_TEST').create('rejected', {}) : new Error('rejected');
    const events = [];
    let checks = 0;
    const call = make(
      {
        output: {
          ...contract,
          result(value) {
            checks++;
            return contract.result(value);
          },
        },
        execute(_context, invocation) {
          invocation.outputWriter.emit('original');
          throw error;
        },
      },
      {
        output: {
          receive: (event) => {
            events.push(event);
          },
        },
      },
    );
    await assert.rejects(call.run(), (observed) => observed === error);
    assert.equal(checks, 0);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['started', 'delta', 'sealed', 'discarded'],
    );
    assert.equal(events.at(-1).reason, domain ? 'exception' : 'failed');
  });
}

test('a locally chosen fallback violating the final type is a nonrecursive producer failure', async () => {
  let handlers = 0;
  const call = make({
    execute() {
      try {
        throw new Error('fallback');
      } catch {
        handlers++;
        return 42;
      }
    },
  });
  await assert.rejects(call.run(), { code: 'OUTPUT_CONTRACT' });
  assert.equal(handlers, 1);
  assert.equal(call.failure.kind, 'error');
});

test('invalid delta remains an owned failure even if business catches it without consumers', async () => {
  const call = make({
    execute(_context, invocation) {
      assert.throws(() => invocation.outputWriter.emit(42), { code: 'OUTPUT_CONTRACT' });
      return 'apparently successful';
    },
  });
  await assert.rejects(call.run(), { code: 'OUTPUT_CONTRACT' });
  assert.equal(call.context.status, 'failed');
});

test('undeclared output and asynchronous validators fail at the producer boundary', async () => {
  for (const output of [undefined, { ...contract, delta: async (value) => value }]) {
    const call = make({
      output,
      execute(_context, invocation) {
        invocation.outputWriter.emit('text');
        return 'final';
      },
    });
    await assert.rejects(call.run(), { code: 'OUTPUT_CONTRACT' });
  }
});

test('final validation preserves original result identity', async () => {
  const result = { value: 1 };
  const call = make({ output: { result: (value) => ({ ...value }) }, execute: () => result });
  await assert.rejects(call.run(), { code: 'OUTPUT_CONTRACT' });
  const accepted = make({ output: { result: (value) => value }, execute: () => result });
  assert.deepEqual(await accepted.run(), result);
});

test('consumer failure is isolated and the failed receiver stays disabled for later events', async () => {
  let received = 0;
  let failures = 0;
  const call = make(
    {
      execute(_context, invocation) {
        invocation.outputWriter.emit('text');
        return 'final';
      },
    },
    {
      output: {
        receive() {
          received++;
          throw new Error('projection failed');
        },
        failed() {
          failures++;
        },
      },
    },
  );
  assert.equal(await call.run(), 'final');
  assert.equal(received, 1);
  assert.equal(failures, 1);
});

test('consumer cancellation during delta delivery stops before final validation', async () => {
  const controller = new AbortController();
  let validated = false;
  const call = make(
    {
      execute(_context, invocation) {
        invocation.outputWriter.emit('part');
        return 'final';
      },
      output: {
        ...contract,
        result(value) {
          validated = true;
          return value;
        },
      },
    },
    {
      signal: controller.signal,
      output: {
        receive(event) {
          if (event.kind === 'delta') controller.abort();
        },
      },
    },
  );
  await assert.rejects(call.run());
  assert.equal(validated, false);
  assert.equal(call.context.status, 'failed');
});

test('cancellation by a terminal receiver cannot reverse the established result', async () => {
  const controller = new AbortController();
  const call = make(
    { execute: () => 'done' },
    {
      signal: controller.signal,
      output: {
        receive(event) {
          if (event.kind === 'completed') controller.abort();
        },
      },
    },
  );
  assert.equal(await call.run(), 'done');
  assert.equal(call.context.status, 'succeeded');
});

test('work rejection seals and discards output without a completed event', async () => {
  const events = [];
  const call = make(
    {
      execute(_context, invocation) {
        invocation.outputWriter.emit('partial');
        throw new Error('work failed');
      },
    },
    {
      output: {
        receive(event) {
          events.push(event);
        },
      },
    },
  );
  await assert.rejects(call.run(), /work failed/);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['started', 'delta', 'sealed', 'discarded'],
  );
});

function composeLevel(Base, child, label, receives, explicit = false) {
  return new (class extends Base {
    name = label;
    label = label;
    source = 'test';
    output = contract;
    constructor() {
      super();
      if (Base !== Node && child) this.add(child);
    }
    deps = {};
    run = async (work) => {
      assert.ok(work.output);
      work.output.emit(label);
      if (!child) return label;
      const call = work.children.create(
        child,
        'input',
        explicit
          ? {
              output: {
                receive(event) {
                  receives.push({ level: label, event });
                },
              },
            }
          : undefined,
      );
      await call.run();
      return call.accept();
    };
  })();
}

test('REOA each declares output; child and host consumers are explicit without ancestor broadcast', async () => {
  const received = [];
  const leaf = composeLevel(Node, undefined, 'A', received);
  const operation = composeLevel(Group, leaf, 'O', received, true);
  const execution = composeLevel(Group, operation, 'E', received, false);
  const runtime = composeLevel(Scene, execution, 'R', received, true);
  const rEvents = [];
  const eEvents = [];
  const bound = installCallable(runtime, {
    providers: [],
    source: {
      entry: () => ({}),
      capture: () => ({}),
      output: () => ({
        receive(event) {
          rEvents.push(event);
        },
      }),
    },
    bindings: [
      bindCallSource(execution, {
        output: () => ({
          receive(event) {
            eEvents.push(event);
          },
        }),
      }),
    ],
  });
  assert.equal(await bound.run('input', {}), 'A');
  assert.deepEqual(
    rEvents.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['R'],
  );
  assert.deepEqual(
    eEvents.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['E'],
  );
  assert.deepEqual(
    received.filter(({ event }) => event.kind === 'delta').map(({ event }) => event.delta),
    ['E', 'A'],
  );
});

test('overlapping calls with the same declaration keep output origins, writers and sequence separate', async () => {
  const events = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const work = {
    async execute(context, invocation) {
      invocation.outputWriter.emit(context.input);
      await held;
      invocation.outputWriter.emit(context.input);
      return context.input;
    },
  };
  const first = make(work, {
    context: new InvocationContext('first'),
    output: {
      receive(event) {
        events.push(event);
      },
    },
  });
  const second = make(work, {
    context: new InvocationContext('second'),
    output: {
      receive(event) {
        events.push(event);
      },
    },
  });
  const firstResult = first.run();
  const secondResult = second.run();
  release();
  assert.deepEqual(await Promise.all([firstResult, secondResult]), ['first', 'second']);
  for (const call of [first, second]) {
    const local = events.filter((event) => event.contextId === call.context.id);
    assert.deepEqual(
      local.map((event) => event.sequence),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      local.filter((event) => event.kind === 'delta').map((event) => event.delta),
      [call.context.input, call.context.input],
    );
  }
});

test('failed child output is discarded independently from the successful parent fallback', async () => {
  const rejected = new ExceptionContract('BOUND_OUTPUT');
  const events = [],
    childEvents = [];
  const child = new Node({
    output: contract,
    run(work) {
      work.output.emit('tentative');
      throw rejected.create('fallback', {});
    },
  });
  const runtime = new Scene({
    output: contract,
    run: (work) =>
      work.children.invoke(child, 'input', {
        output: {
          receive: (event) => {
            childEvents.push(event);
          },
        },
        result: { failed: () => 'fallback' },
      }),
  });
  runtime.add(child);
  const bound = installCallable(runtime, {
    providers: [],
    source: {
      capture: () => ({}),
      output: () => ({
        receive: (event) => {
          events.push(event);
        },
      }),
    },
  });
  assert.equal(await bound.run('input', {}), 'fallback');
  assert.equal(childEvents.at(-1).kind, 'discarded');
  assert.equal(childEvents.at(-1).reason, 'exception');
  assert.equal(events.at(-1).kind, 'completed');
  assert.equal(events.at(-1).result, 'fallback');
});

test('declared output validates the final value selected by business run', async () => {
  let validated;
  const call = make({
    output: {
      ...contract,
      result(value) {
        validated = value;
        return contract.result(value);
      },
    },
    execute: () => 'selected',
  });
  assert.equal(await call.run(), 'selected');
  assert.equal(validated, 'selected');
});

test('one failing explicit E output consumer does not disable its other binding', async () => {
  const execution = composeLevel(Group, undefined, 'E', []);
  const runtime = new (class extends Scene {
    constructor() {
      super();
      this.add(execution);
    }
    deps = {};
    run = async function (work) {
      const child = work.children.create(execution, 'input', {
        output: {
          receive() {
            throw new Error('one consumer failed');
          },
        },
      });
      await child.run();
      return child.accept();
    };
  })();
  const events = [];
  const bound = installCallable(runtime, {
    providers: [],
    source: {
      entry: () => ({}),
      capture: () => ({}),
    },
    bindings: [
      bindCallSource(execution, {
        output: () => ({
          receive(event) {
            events.push(event);
          },
        }),
      }),
    ],
  });
  assert.equal(await bound.run('input', {}), 'E');
  assert.equal(events.at(-1).kind, 'completed');
});

test('final output validation cannot introduce cancellation and still commit its returned result', async () => {
  const controller = new AbortController();
  const events = [];
  const call = make(
    {
      output: {
        ...contract,
        result(value) {
          controller.abort();
          return contract.result(value);
        },
      },
      execute: () => 'accepted before validation',
    },
    {
      signal: controller.signal,
      output: {
        receive(event) {
          events.push(event);
        },
      },
    },
  );
  await assert.rejects(call.run());
  assert.equal(call.context.status, 'failed');
  assert.equal(
    events.some((event) => event.kind === 'completed'),
    false,
  );
});

test('final output validation cannot catch and clear a fault already owned by the invocation', async () => {
  const fault = new Error('resource endpoint rejected during validation');
  const call = make({
    output: {
      ...contract,
      result(value) {
        try {
          call.reject(fault);
          throw fault;
        } catch {}
        return contract.result(value);
      },
    },
    execute: () => 'apparently valid',
  });
  await assert.rejects(call.run(), (error) => error === fault);
  assert.equal(call.context.status, 'failed');
  assert.equal(call.failure.kind, 'error');
});

test('a completed work view cannot create children during a later call', async () => {
  let executions = 0,
    saved;
  const child = new Node({
    run: () => {
      executions++;
      return 'child';
    },
  });
  const definition = new Scene({
    run(work) {
      if (!saved) saved = work;
      else assert.throws(() => saved.children.create(child, 'stale'), /already ended|window|inactive/);
      return 'work';
    },
  });
  definition.add(child);
  const runtime = installCallable(definition, { providers: [], source: { capture: () => ({}) } });
  assert.equal(await runtime.run('first', {}), 'work');
  assert.equal(await runtime.run('second', {}), 'work');
  assert.equal(executions, 0);
});

for (const recovered of [false, true]) {
  test(`a child reference remains receivable after ${recovered ? 'local error recovery' : 'another business step'} in the same run`, async () => {
    const child = new Node({ run: () => 'child' });
    const definition = new Scene({
      async run(work) {
        const call = work.children.create(child, 'input');
        const ref = call.ref;
        await call.run();
        if (recovered) {
          try {
            throw new Error('business choice');
          } catch {}
        } else await Promise.resolve();
        return work.children.open(ref).accept();
      },
    });
    definition.add(child);
    const runtime = installCallable(definition, { providers: [], source: { capture: () => ({}) } });
    assert.equal(await runtime.run('input', {}), 'child');
  });
}

for (const cancelled of [false, true]) {
  test(`delta validation ${cancelled ? 'cancellation' : 'owned failure'} prevents publishing the invalidated increment`, async () => {
    const controller = new AbortController();
    const events = [];
    const fault = new Error('delta validator endpoint rejected');
    const call = make(
      {
        output: {
          ...contract,
          delta(value) {
            if (cancelled) controller.abort();
            else {
              try {
                call.reject(fault);
                throw fault;
              } catch {}
            }
            return contract.delta(value);
          },
        },
        execute(_context, invocation) {
          invocation.outputWriter.emit('must not escape');
          return 'final';
        },
      },
      {
        signal: controller.signal,
        output: {
          receive(event) {
            events.push(event);
          },
        },
      },
    );
    await assert.rejects(call.run());
    assert.equal(call.context.status, 'failed');
    assert.equal(
      events.some((event) => event.kind === 'delta'),
      false,
    );
  });
}
