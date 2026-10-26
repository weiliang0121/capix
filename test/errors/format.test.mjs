import { createInput, observeFixture } from '../fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { RuntimeError } from '@capix/contracts';
import { RuntimeErrorHelper, snapshotValue } from '@capix/server-runtime';

import { validateExecutionRecordSnapshot } from '@capix/protocol';

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

test('cross-realm errors retain diagnostics at the root and inside detail', () => {
  const foreign = runInNewContext('new TypeError("foreign failure")');
  assert.equal(foreign instanceof Error, false);
  const value = recordable(RuntimeErrorHelper.format(foreign));
  assert.equal(value.name, 'TypeError');
  assert.equal(value.message, 'foreign failure');
  const nested = recordable(RuntimeErrorHelper.format(new RuntimeError('OUTER', 'outer', { foreign })));
  assert.equal(nested.detail.foreign.name, 'TypeError');
  assert.equal(nested.detail.foreign.message, 'foreign failure');
});

test('diagnostic predicates do not coerce boxed fields or evaluate type tags and detail accessors', () => {
  const error = new Error('original');
  error.code = new String('BAD_CODE');
  error.message = new String('boxed message');
  let accessed = 0;
  const detail = { number: 0, boolean: false, nil: null, symbol: Symbol('tag') };
  Object.defineProperty(detail, Symbol.toStringTag, {
    get() {
      accessed++;
      throw new Error('must not run');
    },
  });
  Object.defineProperty(detail, '__proto__', { enumerable: true, value: 'ordinary field' });
  Object.defineProperty(detail, 'accessor', {
    enumerable: true,
    get() {
      accessed++;
      throw new Error('must not run');
    },
  });
  error.detail = detail;
  const value = recordable(RuntimeErrorHelper.format(error));
  assert.equal(value.code, 'INTERNAL_ERROR');
  assert.equal(value.message, 'Error message unavailable');
  assert.equal(value.detail.number, 0);
  assert.equal(value.detail.boolean, false);
  assert.equal(value.detail.nil, null);
  assert.equal(value.detail.symbol, '[Symbol: tag]');
  assert.equal(value.detail.__proto__, 'ordinary field');
  assert.equal(value.detail.accessor, '[Accessor not evaluated]');
  assert.equal(accessed, 0);
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

test('unrecordable error detail and aggregates close the Observer execution with diagnostic records', async () => {
  const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
  const input = { content: 'test', history: [] };
  const work = new RuntimeError('WORK', 'failed', { fn: () => {}, map: new Map([['x', 1]]) });
  for (const failure of [work, new AggregateError([work, new TypeError('registration')], 'combined', { cause: work })]) {
    const facts = await observeFixture(createInput(input), settings, {
      async invoke() {
        throw failure;
      },
    });
    validateExecutionRecordSnapshot(facts);
    assert.equal(facts.execution.status, 'failed');
    assert.ok(facts.calls.some((call) => call.structureKind === 'group'));
    assert.ok(facts.calls.some((call) => call.structureKind === 'node'));
    assert.ok(facts.calls.every((call) => call.status !== 'running'));
    assert.equal(facts.boundaries.filter((boundary) => boundary.callId === facts.execution.id).at(-1).value.type, 'throw');
    recordable(facts.execution.value.error);
  }
});
