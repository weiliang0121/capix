import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ModelExchanges, requireExchangeReference } from '@capix/model-exchanges';

// Isolated experiment, NOT a ModelExchanges change or a proposed universal
// history order. One explicit owner selects one linear sequence of closed
// exchanges. Other owners may select those same exchanges in another order.
const formatVersion = 1;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (value) => assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 256, 'Invalid prefix identity');

function checkedToken(value) {
  assert.ok(value && typeof value === 'object', 'Missing prefix token');
  assert.equal(value.formatVersion, formatVersion, 'Unsupported prefix version');
  for (const key of ['id', 'owner', 'collection', 'scope']) identity(value[key]);
  assert.match(value.digest, /^[a-f0-9]{64}$/, 'Invalid prefix digest');
  assert.ok(Number.isSafeInteger(value.count) && value.count > 0, 'Invalid prefix count');
  return Object.freeze({ formatVersion, id: value.id, owner: value.owner, collection: value.collection, scope: value.scope, count: value.count, digest: value.digest });
}

function tokenOf(body) {
  return checkedToken({ ...body, digest: hash(body) });
}

/**
 * Durable prefix metadata, independent of CP. The actual protocol facts remain
 * in the supplied real ModelExchanges. It must outlive/reload alongside this
 * metadata: a compact reference cannot manufacture missing exchange content.
 *
 * append is a fixed-effect confirmation: an exact retry may confirm an earlier
 * committed row even after the tip advances. A new append must match the tip.
 * There is no implicit retry or rewind, and no transaction shared with CP or
 * the exchange entity. Fault hooks are ONLY study interruption probes.
 */
export class ToolPrefixIndex {
  #db;
  #closed = false;
  #mutating = false;
  #exchanges;
  #owner;
  #scope;
  #collection;

  constructor(path, { owner, scope, exchanges, openExisting = false }) {
    identity(owner);
    identity(scope);
    assert.ok(exchanges instanceof ModelExchanges, 'Expected the actual public ModelExchanges entity');
    this.#owner = owner;
    this.#scope = scope;
    this.#collection = exchanges.id;
    this.#exchanges = exchanges;
    this.metrics = { appends: 0, chainReads: 0, nodeReads: 0, tipProbes: 0, duplicateReads: 0, exactExchangeReads: 0, writes: 0, materializations: 0, materializeVisits: 0 };
    this.#db = new DatabaseSync(path);
    try {
      if (!openExisting)
        this.#db.exec(`
        CREATE TABLE IF NOT EXISTS tool_prefix_chains (
          owner TEXT PRIMARY KEY, format_version INTEGER NOT NULL,
          collection TEXT NOT NULL, scope TEXT NOT NULL, tip TEXT
        );
        CREATE TABLE IF NOT EXISTS tool_prefix_nodes (
          id TEXT PRIMARY KEY, owner TEXT NOT NULL, exchange_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL,
          UNIQUE(owner, exchange_id), UNIQUE(owner, ordinal)
        );
      `);
      if (!openExisting) {
        const existing = this.#db.prepare('SELECT owner FROM tool_prefix_chains WHERE owner = ?').get(owner);
        if (!existing) {
          const nodes = this.#db.prepare('SELECT 1 FROM tool_prefix_nodes WHERE owner = ? LIMIT 1').get(owner);
          assert.equal(nodes, undefined, 'Missing prefix chain with existing nodes');
          this.#db.prepare('INSERT INTO tool_prefix_chains VALUES (?, ?, ?, ?, NULL)').run(owner, formatVersion, exchanges.id, scope);
        }
      }
      this.#chain();
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  get owner() {
    return this.#owner;
  }

  #ensureOpen() {
    assert.equal(this.#closed, false, 'Prefix index is closed');
  }

  #chain() {
    this.#ensureOpen();
    this.metrics.chainReads += 1;
    const row = this.#db.prepare('SELECT * FROM tool_prefix_chains WHERE owner = ?').get(this.#owner);
    assert.ok(row, 'Missing prefix chain');
    assert.equal(row.format_version, formatVersion, 'Unsupported stored prefix version');
    assert.equal(row.collection, this.#collection, 'Prefix collection mismatch');
    assert.equal(row.scope, this.#scope, 'Prefix scope mismatch');
    return row;
  }

  #token(value) {
    const token = checkedToken(value);
    assert.equal(token.owner, this.#owner, 'Prefix owner mismatch');
    assert.equal(token.collection, this.#collection, 'Prefix collection mismatch');
    assert.equal(token.scope, this.#scope, 'Prefix scope mismatch');
    return token;
  }

  #decode(row) {
    assert.ok(row, 'Missing prefix row');
    const body = JSON.parse(row.body);
    const token = this.#token(tokenOf(body));
    assert.equal(token.digest, row.digest, 'Damaged prefix body');
    assert.equal(token.id, row.id, 'Prefix row identity mismatch');
    assert.equal(token.owner, row.owner, 'Prefix row owner mismatch');
    assert.equal(token.count, row.ordinal, 'Prefix row ordinal mismatch');
    const exchange = requireExchangeReference(body.exchange);
    assert.equal(exchange.collection, this.#collection, 'Prefix exchange collection mismatch');
    assert.equal(exchange.id, row.exchange_id, 'Prefix exchange identity mismatch');
    const previous = body.previous === null ? null : this.#token(body.previous);
    assert.equal(token.count, previous === null ? 1 : previous.count + 1, 'Broken prefix count');
    // The previous token is bounded metadata. Resolving its ancestry is an
    // explicit cold validation/materialization operation, never a hot append.
    assert.notEqual(previous?.id, token.id, 'Self-referencing prefix');
    return Object.freeze({ token, previous, exchange });
  }

  #read(id) {
    this.metrics.nodeReads += 1;
    return this.#decode(this.#db.prepare('SELECT * FROM tool_prefix_nodes WHERE id = ?').get(id));
  }

  /** Point lookup only. It authenticates metadata, not all ancestors/content. */
  inspect(value) {
    this.#ensureOpen();
    const token = this.#token(value);
    const node = this.#read(token.id);
    assert.deepEqual(node.token, token, 'Inaccurate prefix token');
    return node;
  }

  tip() {
    return this.#tip(this.#chain());
  }

  #tip(chain, known = null) {
    const tip = chain.tip === null ? null : known?.id === chain.tip ? known : this.#read(chain.tip).token;
    this.metrics.tipProbes += 1;
    const later = this.#db.prepare('SELECT 1 FROM tool_prefix_nodes WHERE owner = ? AND ordinal > ? LIMIT 1').get(this.#owner, tip?.count ?? 0);
    assert.equal(later, undefined, 'Prefix tip does not cover later rows');
    return tip;
  }

  append(previousValue, referenceValue, { fault } = {}) {
    this.#ensureOpen();
    assert.equal(this.#mutating, false, 'Prefix append cannot reenter');
    this.#mutating = true;
    this.metrics.appends += 1;
    let committed = false;
    try {
      const previous = previousValue === null ? null : this.inspect(previousValue).token;
      const exchange = requireExchangeReference(referenceValue);
      this.metrics.exactExchangeReads += 1;
      // complete() revises one exchange. closed() proves this exact revision's
      // slots are filled; neither establishes a predecessor or loop order.
      this.#exchanges.closed(this.#scope, [exchange]);
      this.#db.exec('BEGIN IMMEDIATE');
      const chain = this.#chain();
      this.metrics.duplicateReads += 1;
      const existing = this.#db.prepare('SELECT * FROM tool_prefix_nodes WHERE owner = ? AND exchange_id = ?').get(this.#owner, exchange.id);
      let token;
      if (existing) {
        const fixed = this.#decode(existing);
        assert.deepEqual(fixed.previous, previous, 'Exchange already belongs to another prefix position');
        assert.deepEqual(fixed.exchange, exchange, 'Fixed prefix exchange revision changed');
        token = fixed.token;
      } else {
        const tip = this.#tip(chain, previous);
        assert.deepEqual(tip, previous, 'Stale prefix tip');
        const count = (previous?.count ?? 0) + 1;
        assert.ok(Number.isSafeInteger(count), 'Prefix count exhausted');
        const body = { formatVersion, id: randomUUID(), owner: this.#owner, collection: this.#collection, scope: this.#scope, previous, exchange, count };
        token = tokenOf(body);
        this.#db.prepare('INSERT INTO tool_prefix_nodes VALUES (?, ?, ?, ?, ?, ?)').run(token.id, this.#owner, exchange.id, count, JSON.stringify(body), token.digest);
        fault?.('row-inserted');
        this.#db.prepare('UPDATE tool_prefix_chains SET tip = ? WHERE owner = ?').run(token.id, this.#owner);
        fault?.('tip-updated');
      }
      this.#db.exec('COMMIT');
      committed = true;
      if (!existing) this.metrics.writes += 1;
      fault?.('committed');
      return token;
    } catch (error) {
      if (!committed && this.#db.isTransaction) this.#db.exec('ROLLBACK');
      // A committed hook failure is deliberately not recast as "not written".
      // The caller can reopen and confirm the same operation with exact inputs.
      throw error;
    } finally {
      this.#mutating = false;
    }
  }

  /** Actual model requests still need the full selected prefix: O(prefix). */
  materialize(value) {
    this.#ensureOpen();
    this.metrics.materializations += 1;
    if (value === null) return Object.freeze([]);
    const token = this.#token(value);
    const references = [];
    let current = token;
    // count decreases exactly at every step; malformed cycles cannot loop.
    while (current !== null) {
      const node = this.inspect(current);
      references.push(node.exchange);
      this.metrics.materializeVisits += 1;
      current = node.previous;
    }
    assert.equal(references.length, token.count, 'Incomplete prefix');
    references.reverse();
    this.metrics.exactExchangeReads += references.length;
    return this.#exchanges.closed(this.#scope, references);
  }

  /** Cold boundary: no hot-path token or prior entity proof is reused. */
  validate(value) {
    this.#chain();
    // A selected immutable prefix owns its ancestry, not a later append's
    // state. Damaged later rows/tip cannot retroactively change this material.
    return this.materialize(value);
  }

  /** Optional whole-owner audit; deliberately stronger than selected restore. */
  auditChain() {
    const current = this.tip();
    const rows = this.#db.prepare('SELECT count(*) count, max(ordinal) last FROM tool_prefix_nodes WHERE owner = ?').get(this.#owner);
    assert.equal(rows.count, current?.count ?? 0, 'Prefix tip does not cover its stored rows');
    assert.equal(rows.last, current?.count ?? null, 'Prefix tip ordinal mismatch');
    return this.materialize(current);
  }

  close() {
    if (this.#closed) return;
    assert.equal(this.#mutating, false, 'Cannot close during prefix append');
    this.#db.close();
    this.#closed = true;
  }
}
