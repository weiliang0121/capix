import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runner, Resources, Scene, Node, callableHooks } from '@capix/server-runtime';

test('Runner child output uses the exact registered port, preserves final identity and seals its writer', async () => {
  const events = [];
  const parentEvents = [];
  const final = { content: 'hello' };
  let writer;
  const output = { result: (value) => value, delta: (value) => value };
  const child = new Node({
    output,
    run: {
      execute(work) {
        writer = work.output;
        writer.emit('hel');
        writer.emit('lo');
        return final;
      },
    },
  });
  const scene = new Scene({
    output,
    run: {
      async execute(work) {
        const call = work.children.create(child, work.input);
        await call.run();
        return call.accept();
      },
    },
  }).add(child);
  const runner = new Runner(scene, new Resources(), undefined, {
    hooks: [
      callableHooks(child, {
        output: () => ({
          receive: (event) => {
            events.push(event);
          },
        }),
      }),
      callableHooks(scene, {
        output: () => ({
          receive: (event) => {
            parentEvents.push(event);
          },
        }),
      }),
    ],
  }).build();
  assert.equal(await runner.run(null), final);
  assert.deepEqual(
    events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['hel', 'lo'],
  );
  assert.equal(events.find((event) => event.kind === 'completed').result, final);
  assert.equal(
    parentEvents.some((event) => event.kind === 'delta'),
    false,
    'deltas do not implicitly propagate to ancestors',
  );
  assert.notEqual(events[0].contextId, parentEvents[0].contextId);
  assert.throws(
    () => writer.emit('late'),
    (error) => error.code === 'OUTPUT_CLOSED',
  );
  assert.equal(runner.isRunning, false);
});

test('a failing Runner output consumer is isolated from the real result', async () => {
  const result = { content: 'accepted' };
  let reported = 0;
  const scene = new Scene({
    output: { result: (value) => value, delta: (value) => value },
    run: {
      execute(work) {
        work.output.emit('preview');
        return result;
      },
    },
  });
  const runner = new Runner(scene, new Resources(), undefined, {
    hooks: [
      callableHooks(scene, {
        output: () => ({
          receive() {
            throw new Error('consumer failed');
          },
          failed() {
            reported++;
          },
        }),
      }),
    ],
  }).build();
  assert.equal(await runner.run(null), result);
  assert.equal(reported, 1);
});
