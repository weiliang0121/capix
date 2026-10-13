import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, assembleRuntime, RuntimeDefinition, ExecutionDefinition, OperationDefinition, AttemptDefinition } from '@capix/server-runtime';
import { Invocation, InvocationContext } from '@capix/server-runtime/construction';

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
const make = (work, options = {}) => new Invocation({ context: new InvocationContext('input'), signal: new AbortController().signal, work: { maxRounds: 1, output: contract, ...work }, ...options });

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

test('writer is sealed before accept and each continuation receives a different writer', async () => {
  const events = [];
  const writers = [];
  const call = make(
    {
      maxRounds: 2,
      execute(context, invocation) {
        writers.push(invocation.outputWriter);
        if (writers.length > 1) assert.throws(() => writers[0].emit('stale'), { code: 'OUTPUT_CLOSED' });
        invocation.outputWriter.emit(String(context.progress.round));
        return 'value';
      },
      accept(context) {
        assert.throws(() => writers.at(-1).emit('late'), { code: 'OUTPUT_CLOSED' });
        return context.progress.round === 1 ? context.continueWith('again', 'test') : 'final';
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
  assert.equal(await call.run(), 'final');
  assert.notEqual(writers[0], writers[1]);
  assert.deepEqual(
    events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['1', '2'],
  );
  assert.ok(events.some((event) => event.kind === 'discarded' && event.round === 1));
  assert.throws(() => writers[1].emit('after final'), { code: 'OUTPUT_CLOSED' });
  assert.equal(call.context.status, 'succeeded');
});

for (const phase of ['execute', 'accept']) {
  test(`a declared ${phase} exception discards its preview and validates the fallback`, async () => {
    const rejected = new ExceptionContract('OUTPUT_TEST');
    const events = [];
    let checks = 0;
    const call = make(
      {
        raises: [rejected],
        output: {
          ...contract,
          result(value) {
            checks++;
            return contract.result(value);
          },
        },
        execute(_context, invocation) {
          invocation.outputWriter.emit('original');
          if (phase === 'execute') throw rejected.create('fallback', {});
          return 'original';
        },
        accept() {
          throw rejected.create('fallback', {});
        },
        exceptions: {
          accepts: [rejected],
          handle() {
            return { kind: 'return', output: 'fallback' };
          },
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
    assert.equal(await call.run(), 'fallback');
    assert.equal(checks, 1);
    assert.deepEqual(
      events.filter((event) => event.kind === 'discarded').map((event) => event.reason),
      ['exception'],
    );
    assert.equal(events.at(-1).discarded, true);
  });
}

test('fallback violating the declared final type is a nonrecursive producer failure', async () => {
  const rejected = new ExceptionContract('OUTPUT_FALLBACK');
  let handlers = 0;
  const call = make({
    raises: [rejected],
    execute() {
      throw rejected.create('fallback', {});
    },
    exceptions: {
      accepts: [rejected],
      handle() {
        handlers++;
        return { kind: 'return', output: 42 };
      },
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
  assert.equal(await accepted.run(), result);
});

test('consumer failure is isolated and the failed receiver stays disabled across rounds', async () => {
  let received = 0;
  let failures = 0;
  const call = make(
    {
      maxRounds: 2,
      execute(_context, invocation) {
        invocation.outputWriter.emit('text');
        return 'final';
      },
      accept(context, value) {
        return context.progress.round === 1 ? context.continueWith('again', 'test') : value;
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

test('consumer cancellation during delta delivery stops before successful acceptance', async () => {
  const controller = new AbortController();
  let accepted = false;
  const call = make(
    {
      execute(_context, invocation) {
        invocation.outputWriter.emit('part');
        return 'final';
      },
      accept(_context, value) {
        accepted = true;
        return value;
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
  assert.equal(accepted, false);
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
    callee = 'test';
    output = contract;
    children = child ? [child] : [];
    run = {
      requires: {},
      execute: async (_context, invocation, children) => {
        assert.ok(invocation.output);
        invocation.output.emit(label);
        if (!child) return label;
        const call = children.get(child).create(
          invocation,
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
        return children.accept(call, (result) => result);
      },
      accept: (_context, value, invocation) => {
        assert.equal('output' in invocation, false);
        return value;
      },
    };
  })();
}

test('REOA each declares output; child and host consumers are explicit without ancestor broadcast', async () => {
  const received = [];
  const leaf = composeLevel(AttemptDefinition, undefined, 'A', received);
  const operation = composeLevel(OperationDefinition, leaf, 'O', received, true);
  const execution = composeLevel(ExecutionDefinition, operation, 'E', received, false);
  const runtime = composeLevel(RuntimeDefinition, execution, 'R', received, true);
  const rEvents = [];
  const eEvents = [];
  const bound = assembleRuntime(runtime, {
    providers: [],
    source: {
      entry: () => ({}),
      capture: () => ({}),
      output: () => ({
        receive(event) {
          rEvents.push(event);
        },
      }),
      executionOutput: () => ({
        receive(event) {
          eEvents.push(event);
        },
      }),
    },
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

test('bound fallback has no writer and remains subject to the declared result contract', async () => {
  const rejected = new ExceptionContract('BOUND_OUTPUT');
  const runtime = new (class extends RuntimeDefinition {
    output = contract;
    raises = [rejected];
    run = {
      requires: {},
      execute(_context, invocation) {
        invocation.output.emit('tentative');
        throw rejected.create('fallback', {});
      },
    };
    exceptions = {
      requires: {},
      accepts: [rejected],
      handle(_context, _error, invocation) {
        assert.equal('output' in invocation, false);
        return { kind: 'return', output: 'fallback' };
      },
    };
  })();
  const events = [];
  const bound = assembleRuntime(runtime, {
    providers: [],
    source: {
      entry: () => ({}),
      capture: () => ({}),
      output: () => ({
        receive(event) {
          events.push(event);
        },
      }),
    },
  });
  assert.equal(await bound.run('input', {}), 'fallback');
  assert.equal(events.at(-1).discarded, true);
});

test('declared output validation applies to the value transformed by normal acceptance', async () => {
  let validated;
  const call = make({
    output: {
      ...contract,
      result(value) {
        validated = value;
        return contract.result(value);
      },
    },
    execute: () => 'raw',
    accept: () => 'accepted',
  });
  assert.equal(await call.run(), 'accepted');
  assert.equal(validated, 'accepted');
});

test('one failing explicit E output consumer does not disable its other binding', async () => {
  const execution = composeLevel(ExecutionDefinition, undefined, 'E', []);
  const runtime = new (class extends RuntimeDefinition {
    children = [execution];
    run = {
      requires: {},
      async execute(_context, invocation, children) {
        const child = children.get(execution).create(invocation, 'input', {
          output: {
            receive() {
              throw new Error('one consumer failed');
            },
          },
        });
        await child.run();
        return children.accept(child, (value) => value);
      },
    };
  })();
  const events = [];
  const bound = assembleRuntime(runtime, {
    providers: [],
    source: {
      entry: () => ({}),
      capture: () => ({}),
      executionOutput: () => ({
        receive(event) {
          events.push(event);
        },
      }),
    },
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

test('a previous work view cannot create children after the invocation moves to another local round', async () => {
  let executions = 0;
  let saved;
  const child = new (class extends ExecutionDefinition {
    run = {
      requires: {},
      execute: () => {
        executions++;
        return 'child';
      },
    };
  })();
  const definition = new (class extends RuntimeDefinition {
    maxRounds = 2;
    children = [child];
    run = {
      requires: {},
      uses: this.children,
      execute(context, invocation, children) {
        if (context.progress.round === 1) saved = { invocation, children };
        else assert.throws(() => saved.children.get(child).create(saved.invocation, 'stale'), /inactive declaration round/);
        return 'work';
      },
      accept(context, value) {
        return context.progress.round === 1 ? context.continueWith('next', 'continue') : value;
      },
    };
  })();
  const runtime = assembleRuntime(definition, { providers: [], source: { entry: () => ({}), capture: () => ({}) } });
  await assert.rejects(runtime.run('input', {}), /inactive declaration round/);
  assert.equal(executions, 0, 'the stale binding cannot establish new child work');
});

for (const handled of [false, true]) {
  test(`current ${handled ? 'exception' : 'receive'} view can accept a child created by its executing view`, async () => {
    const rejected = new ExceptionContract('ACCEPT_FROM_CURRENT_VIEW');
    let saved;
    const child = new (class extends ExecutionDefinition {
      run = { requires: {}, execute: () => 'child' };
    })();
    const definition = new (class extends RuntimeDefinition {
      children = [child];
      raises = [rejected];
      run = {
        requires: {},
        uses: this.children,
        async execute(_context, invocation, children) {
          saved = children.get(child).create(invocation, 'input');
          const output = await saved.run();
          if (handled) throw rejected.create('use existing result', {});
          return output;
        },
        async accept(_context, _value, invocation, children) {
          assert.equal('output' in invocation, false);
          return children.accept(saved, (result) => result);
        },
      };
      exceptions = {
        requires: {},
        uses: this.children,
        accepts: [rejected],
        async handle(_context, _error, invocation, children) {
          assert.equal('output' in invocation, false);
          return { kind: 'return', output: await children.accept(saved, (result) => result) };
        },
      };
    })();
    const runtime = assembleRuntime(definition, { providers: [], source: { entry: () => ({}), capture: () => ({}) } });
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
