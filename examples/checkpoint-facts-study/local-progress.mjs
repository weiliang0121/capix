import assert from 'node:assert/strict';

const kind = 'call-local-selection@1';
const role = 'selected-material@1';

// Isolated author-side model, not a new entity or a production contract.
// Items are material the invocation has already obtained. This does not prove
// exchange.closed, an external receipt, or any entity's current revision.
export class LocalProgress {
  #call;
  #owner;
  #nodes = new Map();
  stats = { created: 0, nodeChecks: 0, headChecks: 0, proofHits: 0, materializedNodes: 0 };

  constructor(call) {
    this.#call = call;
    this.#owner = call.identity.contextId;
  }

  #token(token) {
    assert.ok(token !== null && typeof token === 'object', 'Missing local token');
    assert.equal(token.owner, this.#owner, 'Wrong local token owner');
    assert.equal(token.role, role, 'Wrong local token role');
    assert.ok(typeof token.id === 'string' && token.id.length > 0, 'Missing local node identity');
    assert.ok(Number.isSafeInteger(token.count) && token.count > 0, 'Invalid local token count');
  }

  #item(item) {
    assert.ok(item !== null && typeof item === 'object', 'Missing selected material');
    assert.ok(typeof item.key === 'string' && item.key.length > 0, 'Missing material key');
    assert.ok(Number.isSafeInteger(item.revision) && item.revision > 0, 'Invalid material revision');
    assert.ok(Array.isArray(item.calls), 'Missing material calls');
    const ids = new Set();
    for (const call of item.calls) {
      assert.ok(typeof call.id === 'string' && call.id.length > 0 && !ids.has(call.id), 'Invalid material call');
      ids.add(call.id);
    }
  }

  // An established node is immutable, so its own predecessor/count/item rule
  // needs checking once per live proof table. Cold recovery rebuilds this proof.
  // That proof says nothing about which node the next head should select.
  #node(token) {
    if (token === null) return null;
    const path = [];
    const seen = new Set();
    let cursor = token;
    let prior = null;
    while (cursor !== null) {
      this.#token(cursor);
      assert.ok(!seen.has(cursor.id), 'Cyclic local prefix');
      const known = this.#nodes.get(cursor.id);
      if (known) {
        assert.deepEqual(cursor, known.token, 'Local token does not match its fixed node');
        this.stats.proofHits++;
        prior = known.node;
        break;
      }
      seen.add(cursor.id);
      const node = this.#call.material(cursor.id);
      assert.equal(node.kind, kind, 'Wrong local material kind');
      assert.equal(node.owner, this.#owner, 'Wrong local node owner');
      assert.equal(node.role, role, 'Wrong local node role');
      assert.equal(node.count, cursor.count, 'Local token count mismatch');
      this.#item(node.item);
      path.push({ token: Object.freeze({ ...cursor }), node });
      cursor = node.previous;
    }
    for (const entry of path.reverse()) {
      assert.equal(entry.node.count, (prior?.count ?? 0) + 1, 'Local prefix position mismatch');
      this.#nodes.set(entry.token.id, entry);
      this.stats.nodeChecks++;
      prior = entry.node;
    }
    return this.#nodes.get(token.id).node;
  }

  append(previous, item) {
    const prior = this.#node(previous);
    this.#item(item);
    const count = (prior?.count ?? 0) + 1;
    assert.ok(Number.isSafeInteger(count), 'Local prefix count exceeded');
    // capture owns a fixed copy now, but does not persist it separately. The
    // next FactCall.save publishes this node, other facts, and head atomically.
    const id = this.#call.capture({ kind, owner: this.#owner, role, previous, count, item });
    const token = Object.freeze({ owner: this.#owner, role, id, count });
    this.#node(token);
    this.stats.created++;
    return token;
  }

  check(point, state) {
    this.stats.headChecks++;
    assert.ok(['processing', 'completed'].includes(point), 'Unknown local progress point');
    const selected = this.#node(state.prefix);
    if (selected === null) {
      assert.equal(state.current, null, 'Empty selection has no current material');
      assert.equal(state.cursor, 0, 'Empty selection cannot advance');
      assert.equal(state.active, null, 'Empty selection has no active call');
      return;
    }
    // B: current combination is checked on EVERY save, including no-new-fact
    // saves, reselecting an old branch, and moving to a different point.
    assert.deepEqual(state.current, { key: selected.item.key, revision: selected.item.revision }, 'Current material does not match selected prefix');
    assert.ok(Number.isSafeInteger(state.cursor) && state.cursor >= 0 && state.cursor <= selected.item.calls.length, 'Invalid current cursor');
    assert.ok(state.active === null || (state.cursor < selected.item.calls.length && state.active === selected.item.calls[state.cursor].id), 'Active call does not match current cursor');
    if (point === 'completed') {
      assert.equal(state.cursor, selected.item.calls.length, 'Completed point has unconsumed calls');
      assert.equal(state.active, null, 'Completed point has an active call');
    }
  }

  save(point, state, options = {}) {
    assert.equal(options.check, undefined, 'Local check cannot be replaced');
    return this.#call.save(point, state, { ...options, check: (fixed) => this.check(point, fixed) });
  }

  // Explicit O(selected history), for consumers that really need its contents.
  // Saving and validating the current combination never call materialize.
  materialize(token) {
    const items = [];
    let node = this.#node(token);
    while (node !== null) {
      items.push(node.item);
      this.stats.materializedNodes++;
      node = this.#node(node.previous);
    }
    return Object.freeze(items.reverse());
  }
}
