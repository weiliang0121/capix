import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, Node, Resources, Runner, Scene, reception } from '@capix/server-runtime';
import { inspectChildCallFailure } from '@capix/invocation';

const codec = { encode: (value) => value, decode: (value) => value };
const checkpoint = (contracts) => ({ key: 'test.work-adapter', version: 1, input: codec, output: codec, points: [], receptions: contracts });

function invoke(mode, work, child, options) {
  return mode === 'direct' ? work.children.invoke(child, null, options) : work.children.create(child, null, { key: options.key, output: options.output }).invoke(options);
}

for (const mode of ['direct', 'handle']) {
  test(`${mode} invocation fixes result methods and output configuration while preserving receivers and typed values`, async () => {
    const gate = Promise.withResolvers();
    const delivered = { content: 'child output' };
    const accepted = { content: 'accepted output' };
    const events = [];
    let facts;
    const child = new Node({
      output: { result: (value) => value, delta: (value) => value },
      async run(work) {
        await gate.promise;
        work.output.emit('preview');
        return delivered;
      },
    });
    const contract = reception(child, { ...codec, check: (value) => assert.equal(value, accepted) });
    const scene = new Scene({
      checkpoint: checkpoint([contract]),
      async run(work) {
        facts = work.children.facts;
        const result = {
          marker: 'initial',
          succeeded(value) {
            assert.equal(this, result);
            assert.equal(this.marker, 'live');
            assert.equal(value, delivered);
            return accepted;
          },
          failed: () => assert.fail('the child succeeds'),
        };
        const output = {
          marker: 'initial',
          receive(event) {
            assert.equal(this, output);
            if (event.kind === 'delta') {
              assert.equal(this.marker, 'live');
              events.push(event.delta);
            }
          },
        };
        const options = { key: 'fixed', result, output, reception: contract };
        const pending = invoke(mode, work, child, options);
        result.marker = 'live';
        result.succeeded = () => assert.fail('the original result method is fixed');
        result.failed = () => assert.fail('the original failure method is fixed');
        output.marker = 'live';
        if (mode === 'direct') output.receive = () => assert.fail('the original output method is fixed');
        options.key = 'changed';
        options.output = { receive: () => assert.fail('the original output receiver is fixed') };
        gate.resolve();
        assert.equal(await pending, accepted);
        const fact = facts.list(child)[0];
        assert.equal(fact.key, 'fixed');
        assert.equal(fact.returned.output, delivered);
        assert.equal(facts.accepted(fact.ref, contract), accepted);
        return accepted;
      },
    }).add(child);
    assert.equal(await new Runner(scene, new Resources()).build().run(null), accepted);
    assert.equal(facts.list(child)[0].reception.value, accepted);
    assert.deepEqual(events, ['preview']);
  });

  test(`${mode} invocation binds the failed receiver before starting and retains the real failed delivery`, async () => {
    const gate = Promise.withResolvers();
    const failure = new Error('child failed');
    const handled = { recovered: true };
    const child = new Node({
      async run() {
        await gate.promise;
        throw failure;
      },
    });
    const contract = reception(child, { ...codec, check: (value) => assert.equal(value, handled) });
    const scene = new Scene({
      checkpoint: checkpoint([contract]),
      async run(work) {
        const result = {
          succeeded: () => assert.fail('the child fails'),
          failed(error) {
            assert.equal(this, result);
            assert.equal(error, failure);
            return handled;
          },
        };
        const pending = invoke(mode, work, child, { result, reception: contract });
        result.failed = () => assert.fail('the failed receiver was already fixed');
        gate.resolve();
        assert.equal(await pending, handled);
        const fact = work.children.facts.list(child)[0];
        assert.equal(fact.returned.status, 'failed');
        assert.equal(fact.returned.diagnostic.message, failure.message);
        assert.equal(fact.reception.status, 'handled');
        return work.children.facts.handled(fact.ref, contract);
      },
    }).add(child);
    assert.equal(await new Runner(scene, new Resources()).build().run(null), handled);
  });

  test(`${mode} reception failure preserves its exact child origin without entering failed`, async () => {
    const failure = new ExceptionContract('WORK_ADAPTER_RECEPTION').create('reception failed', {});
    const child = new Node({ run: () => 'delivered' });
    let failed = 0;
    let source;
    const scene = new Scene({
      async run(work) {
        try {
          return await invoke(mode, work, child, {
            result: {
              succeeded() {
                throw failure;
              },
              failed() {
                failed++;
                return 'cannot handle reception failure';
              },
            },
          });
        } catch (error) {
          source = inspectChildCallFailure(error);
          const fact = work.children.facts.list(child)[0];
          assert.equal(source.exception, failure);
          assert.equal(source.origin.kind, 'child-reception');
          assert.equal(source.origin.child.parentRound, fact.parentRound);
          assert.equal(source.origin.child.order, fact.order);
          assert.equal(fact.returned.output, 'delivered');
          assert.equal(fact.reception.status, 'failed');
          throw error;
        }
      },
    }).add(child);
    await assert.rejects(new Runner(scene, new Resources()).build().run(null), (error) => error === failure);
    assert.equal(failed, 0);
    assert.ok(source);
  });

  test(`${mode} invocation rejects invalid result or reception options before child work starts`, async (t) => {
    for (const invalid of ['succeeded', 'failed', 'unregistered', 'different-child']) {
      await t.test(invalid, async () => {
        let starts = 0;
        let receipts = 0;
        const child = new Node({ run: () => ++starts });
        const other = new Node({ run: () => assert.fail('unselected child') });
        const contract = reception(invalid === 'different-child' ? other : child, { ...codec, check: () => undefined });
        const options = { result: { succeeded: () => ++receipts, failed: () => ++receipts } };
        if (invalid === 'succeeded' || invalid === 'failed') options.result[invalid] = 'not a callback';
        else options.reception = contract;
        const scene = new Scene({
          checkpoint: checkpoint(invalid === 'different-child' ? [contract] : []),
          run: (work) => invoke(mode, work, child, options),
        }).add(child, other);
        const expected = invalid === 'succeeded' ? /Success receiver/ : invalid === 'failed' ? /Failure receiver/ : invalid === 'unregistered' ? /not registered/ : /different child/;
        await assert.rejects(new Runner(scene, new Resources()).build().run(null), expected);
        assert.equal(starts, 0);
        assert.equal(receipts, 0);
      });
    }
  });
}
