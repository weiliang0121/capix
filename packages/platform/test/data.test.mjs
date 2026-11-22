import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { decodeBase64, encodeUtf8, utf8ByteLength } from '@weiliang0121/capix-platform/bytes';
import { equalData } from '@weiliang0121/capix-platform/equal';
import { equalData as equalPortableData } from '../dist/data-equality.js';
import { createSha256 } from '@weiliang0121/capix-platform/hash';

test('UTF-8 measurement and encoding match native bytes with and without TextEncoder', () => {
  const verify = () => {
    for (const text of ['', 'abc', '\u0000\u007f\u0080\u07ff\u0800\uffff', '中文😊', '\ud800\ud800\udfff\udfff']) {
      assert.equal(utf8ByteLength(text), Buffer.byteLength(text));
      assert.deepEqual(encodeUtf8(text), Uint8Array.from(Buffer.from(text)));
    }
  };
  verify();
  const encoder = globalThis.TextEncoder;
  try {
    globalThis.TextEncoder = undefined;
    verify();
  } finally {
    globalThis.TextEncoder = encoder;
  }
});

test('SHA-256 matches native incremental updates and independent prefix copies', () => {
  const chunks = ['capix.固定.v1\n', '0'.repeat(63), '\ud83d', '\ude00', '\n'];
  const native = createHash('sha256');
  const portable = createSha256();
  for (const text of chunks) {
    assert.equal(portable.copy().update('fork').digestHex(), native.copy().update('fork').digest('hex'));
    native.update(text);
    portable.update(text);
  }
  assert.equal(portable.digestHex(), native.digest('hex'));
  assert.throws(() => portable.update('after digest'));
  assert.throws(() => portable.copy());
  assert.throws(() => portable.digestHex());
});

test('canonical padded Base64 matches native bytes across block boundaries', () => {
  for (const length of [0, 1, 2, 3, 12287, 12288, 12289, 32768]) {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index++) bytes[index] = index % 256;
    assert.deepEqual(decodeBase64(bytes.toString('base64')), Uint8Array.from(bytes));
  }
  for (const input of ['Zg', 'Zh==', 'Zm9=', 'Zg= ', 'Zg==\n', '____', 'AA=A', 'AAAA====', 'A'.repeat(16382) + '==AAAA']) assert.throws(() => decodeBase64(input));
});

test('fixed data comparison preserves strict scalar, record and array semantics', () => {
  for (const [left, right] of [
    [-0, 0],
    [NaN, NaN],
    [null, undefined],
    [{ a: -0 }, { a: 0 }],
    [
      { a: 1, b: [2, 3] },
      { b: [2, 3], a: 1 },
    ],
    [Object.create(null), {}],
    [Object.assign(Object.create(null), { a: 'b' }), Object.assign(Object.create(null), { a: 'b' })],
    [Array(1), []],
    [Array(1), [undefined]],
    [Array(1), Array(1)],
    [
      [1, 2],
      [2, 1],
    ],
    [[], {}],
    [JSON.parse('{"__proto__": 2}'), { missing: 2 }],
  ])
    assert.equal(equalPortableData(left, right), isDeepStrictEqual(left, right));
  const accessor = {
    get x() {
      throw new Error('getter ran');
    },
  };
  assert.equal(equalPortableData(accessor, { x: 1 }), false);
  const opaque = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('proxy trap ran');
      },
    },
  );
  assert.equal(equalPortableData({ nested: opaque }, { nested: {} }), false);
});

test('Node schema-result comparisons retain native getter and non-enumerable behavior', () => {
  let reads = 0;
  const parsed = {
    get field() {
      reads++;
      return -0;
    },
  };
  Object.defineProperty(parsed, 'metadata', { value: 'parser detail' });
  assert.equal(equalData(parsed, { field: -0 }), true);
  assert.equal(reads, 1);
});
