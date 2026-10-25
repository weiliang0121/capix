import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sequence, Scene, Group, bindCallSource } from '@capix/server-runtime';

const output = { result: (value) => value, delta: (value) => value };

test('Sequence binds declared output explicitly while final parent acceptance remains independent', async () => {
  const phases = [];
  const operation = new (class extends Group {
    name = 'source';
    label = 'source';
    source = 'test';
    output = output;
    deps = {};
    run = function (work) {
      work.output.emit('child text');
      return 'result';
    };
  })();
  const execution = new (class extends Group {
    output = output;
    constructor() {
      super();
      this.add(operation);
    }
    deps = {};
    run = async function (work) {
      const composition = new Sequence().step('source', {
        use: operation,
        input: () => null,
        output: () => ({
          receive(event) {
            if (event.kind === 'delta') {
              phases.push('delta');
              work.output.emit(event.delta.toUpperCase());
            }
            if (event.kind === 'completed') phases.push('child-completed');
          },
        }),
        accept: (_scope, value) => {
          phases.push('parent-accept');
          return value;
        },
      });
      return (await composition.run(work.input, work.children)).source;
    };
  })();
  const runtime = new (class extends Scene {
    constructor() {
      super();
      this.add(execution);
    }
    deps = {};
    run = async function (work) {
      const child = work.children.create(execution, null);
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
  assert.equal(await bound.run(null, {}), 'result');
  assert.deepEqual(
    events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['CHILD TEXT'],
  );
  assert.deepEqual(phases, ['delta', 'child-completed', 'parent-accept']);
});
