import { acceptQuery } from '../../dist/server/query/input.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeError } from '../../dist/server/errors/error.js';
import { RuntimeErrorHelper } from '../../dist/server/errors/helper.js';
import { snapshotValue } from '../../dist/server/records/value/snapshot.js';
import { runQuery } from '../../dist/server/query/run.js';
import { validateSnapshot } from '../../dist/shared/execution/project.js';

function recordable(value) {
  const snapshot = snapshotValue(value);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  return snapshot;
}

test('runtime and native errors retain diagnostics and cause without changing the exception', () => {
  const cause = new TypeError('invalid argument');
  const detail = { field: 'city', nested: [1] };
  const error = new RuntimeError('BAD_INPUT', 'cannot prepare', detail, { cause });
  const value = recordable(RuntimeErrorHelper.format(error));
  assert.equal(value.name, 'RuntimeError');
  assert.equal(value.code, 'BAD_INPUT');
  assert.equal(value.message, 'cannot prepare');
  assert.equal(value.stack, error.stack);
  assert.equal(value.cause.name, 'TypeError');
  assert.equal(value.cause.message, 'invalid argument');
  assert.equal(value.cause.stack, cause.stack);
  assert.equal(error.cause, cause);
  detail.nested.push(2);
  assert.deepEqual(value.detail.nested, [1]);
  const native = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  assert.equal(RuntimeErrorHelper.format(native).code, 'ECONNRESET');
});

test('aggregate errors keep member order and cause, including nested aggregates', () => {
  const work = new RuntimeError('WORK_FAILED', 'work');
  const registration = new DOMException('cannot clone', 'DataCloneError');
  const error = new AggregateError([work, new AggregateError([registration], 'inner')], 'both failed', { cause: work });
  const value = recordable(RuntimeErrorHelper.format(error));
  assert.equal(value.code, 'AGGREGATE_ERROR');
  assert.equal(value.errors[0].code, 'WORK_FAILED');
  assert.equal(value.errors[1].errors[0].name, 'DataCloneError');
  assert.equal(value.cause.code, 'WORK_FAILED');
});

test('unsupported detail becomes detached JSON with explicit markers', () => {
  let accessed = false;
  const detail = {
    fn: () => {},
    big: 3n,
    symbol: Symbol('x'),
    missing: undefined,
    nan: NaN,
    infinity: Infinity,
    map: new Map([['city', '上海']]),
    set: new Set([1, 2]),
    date: new Date('2026-09-21T00:00:00Z'),
    invalidDate: new Date(NaN),
    nested: new Error('nested detail'),
  };
  detail.self = detail;
  Object.defineProperty(detail, 'getter', {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error('must not run');
    },
  });
  const value = recordable(RuntimeErrorHelper.format(new RuntimeError('TEST', 'test', detail)));
  assert.equal(accessed, false);
  assert.equal(value.detail.fn, '[Function]');
  assert.equal(value.detail.big, '[BigInt: 3]');
  assert.equal(value.detail.missing, '[Undefined]');
  assert.equal(value.detail.self, '[Circular reference]');
  assert.equal(value.detail.getter, '[Accessor not evaluated]');
  assert.deepEqual(value.detail.map, { type: 'Map', entries: [['city', '上海']] });
  assert.equal(value.detail.nested.message, 'nested detail');
});

test('non-Error throws, unreadable properties and revoked proxies remain recordable', () => {
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  for (const error of [undefined, null, 'thrown string', 42, 1n, Symbol('x'), () => {}, { reason: 'bad' }, proxy.proxy]) recordable(RuntimeErrorHelper.format(error));
  const error = new Error('test');
  Object.defineProperty(error, 'stack', {
    get() {
      throw new Error('unreadable');
    },
  });
  const value = recordable(RuntimeErrorHelper.format(error));
  assert.equal(value.message, 'test');
  assert.equal(value.stack, '[Unreadable property]');
});

test('circular and oversized diagnostics stop with visible markers', () => {
  const error = new AggregateError([], 'x'.repeat(20000));
  error.cause = error;
  error.errors.push(error);
  let detail = {};
  for (let i = 0; i < 100; i++) detail = { child: detail };
  error.detail = { deep: detail, wide: Array.from({ length: 200 }, (_, index) => index) };
  const value = recordable(RuntimeErrorHelper.format(error));
  assert.equal(value.cause.code, 'CIRCULAR_ERROR');
  assert.equal(value.errors[0].code, 'CIRCULAR_ERROR');
  assert.match(value.message, /Truncated: string limit/);
  assert.match(JSON.stringify(value.detail), /Truncated: error conversion limit/);
  assert.equal(value.detail.wide.at(-1), '[Truncated: entry limit]');
});

test('one conversion shares its budget across detail, cause and members, then resets for the next call', () => {
  const cause = new Error('cause');
  const error = new AggregateError([cause], 'outer', { cause });
  error.detail = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 1));
  const value = recordable(RuntimeErrorHelper.format(error));
  assert.equal(value.cause.code, 'ERROR_TRUNCATED');
  assert.equal(value.errors[0].code, 'ERROR_TRUNCATED');
  assert.equal(RuntimeErrorHelper.format(cause).message, 'cause');

  const shared = { city: 'Shanghai' };
  const repeated = recordable(RuntimeErrorHelper.format(new RuntimeError('X', 'x', { first: shared, second: shared })));
  assert.deepEqual(repeated.detail.first, repeated.detail.second);
  assert.notEqual(repeated.detail.first, repeated.detail.second);
});

test('unrecordable error detail and aggregates close the query execution with diagnostic records', async () => {
  const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
  const input = { query: 'test', history: [] };
  const work = new RuntimeError('WORK', 'failed', { fn: () => {}, map: new Map([['x', 1]]) });
  for (const failure of [work, new AggregateError([work, new TypeError('registration')], 'combined', { cause: work })]) {
    const facts = await runQuery(acceptQuery(input), settings, {
      async invoke() {
        throw failure;
      },
    });
    validateSnapshot(facts);
    assert.equal(facts.execution.status, 'failed');
    assert.ok(facts.operations.every((operation) => operation.status !== 'running'));
    assert.ok(facts.attempts.every((attempt) => attempt.status !== 'running'));
    assert.equal(facts.events.at(-1).type, 'throw');
    recordable(facts.execution.value.error);
  }
});
