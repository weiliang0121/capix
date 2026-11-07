import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node } from '@capix/structure';
import { BoundChildren, savedCheckpointFacts } from '@capix/server-runtime/construction';

function queryFixture(size = 8) {
  const node = new Node({ run: (work) => work.input });
  const children = new BoundChildren([{ definition: node, declaration: { kind: 'node' } }]);
  let relationReads = 0;
  let inputReads = 0;
  const records = new Map(
    Array.from({ length: size }, (_, order) => {
      const id = 'child-' + order;
      const input = Object.freeze({ order });
      return [
        id,
        Object.freeze({
          identity: { contextId: id, parentContextId: 'parent', kind: 'node' },
          target: { position: 0 },
          round: 1,
          order,
          get input() {
            inputReads++;
            return input;
          },
          state: { kind: 'waiting' },
        }),
      ];
    }),
  );
  const wires = Object.freeze(Array.from({ length: size }, (_, order) => Object.freeze({ contextId: 'child-' + order, parentContextId: 'parent', parentRound: 1, order, target: { position: 0 } })));
  const frame = {
    owner: { contextId: 'parent', kind: 'group' },
    input: null,
    currentInput: null,
    round: 1,
    get children() {
      assert.fail('indexed query must not enumerate all relations');
    },
    child(id) {
      relationReads++;
      return records.get(id);
    },
  };
  const query = savedCheckpointFacts(frame, { items: wires, duplicates: Object.freeze([wires[0], wires[0]]), empty: Object.freeze([]) }, children);
  return {
    query,
    get relationReads() {
      return relationReads;
    },
    get inputReads() {
      return inputReads;
    },
  };
}

test('checkpoint many queries keep Array compatibility while index and at only read selected facts', () => {
  const fixture = queryFixture(512);
  const query = fixture.query;
  const items = query.facts.references.items;
  assert.equal(Array.isArray(items), true);
  assert.equal(items.length, 512);
  assert.equal(fixture.relationReads, 0);
  assert.equal(items.at(-1).input.order, 511);
  assert.equal(fixture.relationReads, 1);
  assert.equal(fixture.inputReads, 1);
  assert.equal(items[511], items.at(-1));
  assert.equal(fixture.inputReads, 1, 'repeated access reuses the already-built stable fact');
  assert.equal(items.at(-512).input.order, 0);
  assert.equal(items.at(-513), undefined);
  assert.equal(items.at(512), undefined);
  assert.equal(items[512], undefined);
  assert.equal(items[-1], undefined);
  assert.equal(query.facts.references.empty.at(-1), undefined);
  assert.equal(query.facts.references.empty.length, 0);
  assert.equal(query.facts.references.duplicates[0], query.facts.references.duplicates[1]);
  query.close();
});

test('checkpoint many explicit enumeration pays for its actual items', () => {
  const fixture = queryFixture(5);
  const items = fixture.query.facts.references.items;
  const seen = [];
  items.forEach((fact, index) => seen.push([index, fact.input.order]));
  assert.deepEqual(seen, [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ]);
  assert.equal(fixture.relationReads, 5);
  assert.equal(fixture.inputReads, 5);
  assert.deepEqual(
    items.map((fact) => fact.input.order),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    items.filter((fact) => fact.input.order % 2).map((fact) => fact.input.order),
    [1, 3],
  );
  assert.deepEqual(
    [...items].map((fact) => fact.input.order),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(Object.keys(items), ['0', '1', '2', '3', '4']);
  assert.deepEqual(
    Object.entries(items).map(([key, value]) => [key, value.input.order]),
    [
      ['0', 0],
      ['1', 1],
      ['2', 2],
      ['3', 3],
      ['4', 4],
    ],
  );
  assert.equal(4 in items, true);
  assert.equal(5 in items, false);
  assert.equal(Object.getOwnPropertyDescriptor(items, 'length').value, 5);
  assert.equal(fixture.inputReads, 5);
  fixture.query.close();
});

test('checkpoint many ports reject mutation and expiration without invalidating returned facts', () => {
  const { query } = queryFixture(3);
  const items = query.facts.references.items;
  const fact = items[0];
  const iterator = items.values();
  assert.equal(iterator.next().value, fact);
  for (const modify of [
    () => {
      items[0] = fact;
    },
    () => {
      items.length = 0;
    },
    () => items.push(fact),
    () => items.splice(0, 1),
    () => {
      delete items[0];
    },
    () => Object.defineProperty(items, '0', { value: fact }),
    () => Object.setPrototypeOf(items, null),
    () => Object.freeze(items),
  ])
    assert.throws(modify, /read-only/);
  assert.equal(items.length, 3, 'failed freezing does not alter the target or its proxy invariants');
  query.close();
  for (const read of [() => items.length, () => items[0], () => items.at(-1), () => Object.keys(items), () => iterator.next(), () => query.facts.references.items]) assert.throws(read, /synchronous checkpoint check/);
  assert.equal(fact.input.order, 0);
  assert.equal(Object.isFrozen(fact), true);
  const other = queryFixture(3);
  assert.throws(() => other.query.facts.children.get(fact.ref), /foreign/);
  other.query.close();
});
