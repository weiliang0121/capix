import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StableValues } from './stable.mjs';

// A separately versioned experiment. Not CheckpointStore, Frame v6, or a
// general event store. SQLite and the coordinator below share a trusted process.
export const hash = (text) => createHash('sha256').update(text).digest('hex');
const emptyHash = hash('fact-head-study@1');
const pack = (value) => JSON.stringify(value);
const bytes = (value) => Buffer.byteLength(value);

export function identity(contextId, parentId = null, position = 'root', order = 0, contract = 'study@1') {
  return Object.freeze({ contextId, parentId, position, order, contract });
}

function checkIdentity(value) {
  assert.equal(typeof value.contextId, 'string');
  assert.ok(value.contextId.length > 0);
  assert.ok(value.parentId === null || (typeof value.parentId === 'string' && value.parentId !== value.contextId));
  assert.ok(typeof value.position === 'string' && value.position.length > 0);
  assert.ok(typeof value.contract === 'string' && value.contract.length > 0);
  assert.ok(Number.isSafeInteger(value.order) && value.order >= 0);
}

// Checks ALL state transitions, including intermediate receiving, not just
// terminal acceptance. Returned failure and parent handling remain distinct.
export function checkRelation(previous, next) {
  checkIdentity(next.identity);
  assert.ok(next.key === undefined || typeof next.key === 'string', 'Invalid relation key');
  assert.ok(next.identity.parentId !== null);
  if (!previous) {
    assert.equal(next.phase, 'waiting');
    assert.equal(next.identity.order > 0, true);
    assert.equal(next.output, null);
    assert.equal(next.result, null);
    assert.equal(next.received, null);
    assert.equal(next.reception, null);
    return;
  }
  for (const key of ['identity', 'input']) assert.deepEqual(next[key], previous[key], 'Relation basis changed');
  assert.equal(next.key, previous.key, 'Relation key changed');
  const allowed = { waiting: ['returned'], returned: ['receiving'], receiving: ['accepted', 'handled'], accepted: [], handled: [] };
  assert.ok(allowed[previous.phase]?.includes(next.phase), 'Illegal relation transition');
  if (previous.phase !== 'waiting') {
    assert.equal(next.output, previous.output);
    assert.equal(next.result, previous.result);
    assert.equal(next.allowed, previous.allowed);
  }
  if (next.phase === 'returned') {
    assert.ok(['succeeded', 'failed'].includes(next.result));
    assert.equal(typeof next.output, 'string');
    assert.equal(typeof next.allowed, 'boolean');
    assert.equal(next.received, null);
    assert.equal(next.reception, null);
  }
  if (next.phase === 'receiving') {
    assert.ok(typeof next.reception === 'string' && next.reception.length > 0);
    assert.equal(next.received, null);
    assert.ok(next.result === 'succeeded' || next.allowed, 'Protected failure cannot be handled');
  }
  if (next.phase === 'accepted' || next.phase === 'handled') {
    assert.equal(next.reception, previous.reception, 'Reception contract changed');
    assert.equal(next.result, next.phase === 'accepted' ? 'succeeded' : 'failed');
    assert.equal(typeof next.received, 'string');
  }
}

function factFor(get, id, owner, kind) {
  const fact = get(id);
  assert.ok(fact, 'Missing fact');
  assert.equal(fact.owner, owner, 'Wrong fact owner');
  assert.equal(fact.kind, kind, 'Wrong fact kind');
  return fact;
}

function relationFacts(next, get) {
  factFor(get, next.input, next.identity.contextId, 'input');
  if (next.output !== null) factFor(get, next.output, next.identity.contextId, next.result === 'succeeded' ? 'returned' : 'failure');
  if (next.received !== null) factFor(get, next.received, next.identity.parentId, next.phase);
}

function checkReference(reference, relation, owner) {
  assert.ok(relation, 'Unknown reference');
  assert.deepEqual(reference, relation.identity, 'Inaccurate reference');
  assert.equal(reference.parentId, owner, 'Foreign reference');
}

// Ordered occurrences, not a set of children: one child may fill several roles.
// Links make insertion/removal touch only neighbours; enumeration is explicit.
export class ReferenceList {
  #entries = new Map();
  #counts = new Map();
  head = null;
  tail = null;

  get size() {
    return this.#entries.size;
  }
  has(child) {
    return (this.#counts.get(child) ?? 0) > 0;
  }

  entry(id) {
    const entry = this.#entries.get(id);
    return entry && Object.freeze({ id: entry.id, child: entry.child });
  }

  add(id, child, before = null) {
    assert.ok(typeof id === 'string' && id.length > 0 && !this.#entries.has(id), 'Duplicate reference occurrence');
    assert.ok(before === null || this.#entries.has(before), 'Missing reference insertion anchor');
    const next = before === null ? undefined : this.#entries.get(before);
    const previous = next ? next.previous : this.tail;
    const entry = { id, child, previous, next: before };
    if (previous !== null) this.#entries.get(previous).next = id;
    else this.head = id;
    if (next) next.previous = id;
    else this.tail = id;
    this.#entries.set(id, entry);
    this.#counts.set(child.contextId, (this.#counts.get(child.contextId) ?? 0) + 1);
  }

  remove(id) {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    if (entry.previous !== null) this.#entries.get(entry.previous).next = entry.next;
    else this.head = entry.next;
    if (entry.next !== null) this.#entries.get(entry.next).previous = entry.previous;
    else this.tail = entry.previous;
    this.#entries.delete(id);
    const count = this.#counts.get(entry.child.contextId) - 1;
    if (count === 0) this.#counts.delete(entry.child.contextId);
    else this.#counts.set(entry.child.contextId, count);
    return true;
  }

  entries() {
    const result = [];
    let current = this.head;
    while (current !== null) {
      const entry = this.#entries.get(current);
      assert.ok(entry && result.length < this.size, 'Broken reference order');
      result.push({ id: entry.id, child: entry.child });
      current = entry.next;
    }
    assert.equal(result.length, this.size, 'Missing reference occurrence');
    return result;
  }
}

function referenceKind(kinds, slot, kind) {
  assert.ok(typeof slot === 'string' && slot.length > 0);
  const previous = kinds.get(slot);
  assert.ok(previous === undefined || previous === kind, 'Reference cardinality changed');
  kinds.set(slot, kind);
}

export class FactStore {
  db;
  stats = { commits: 0, factsWritten: 0, factBytesWritten: 0, metadataEvents: 0, metadataBytesWritten: 0, headBytesWritten: 0, metadataReads: 0, oldBodyReads: 0, restoreFacts: 0, restoreEvents: 0 };
  #statements = new Map();

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, codec TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS events(owner TEXT NOT NULL, seq INTEGER NOT NULL, previous TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,seq)) STRICT;
      CREATE TABLE IF NOT EXISTS heads(owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS relations(owner TEXT NOT NULL, child TEXT NOT NULL, position INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,child), UNIQUE(owner,position)) STRICT;
      CREATE TABLE IF NOT EXISTS refs(owner TEXT NOT NULL, slot TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(owner,slot)) STRICT;
      CREATE TABLE IF NOT EXISTS ref_slots(owner TEXT NOT NULL, slot TEXT NOT NULL, kind TEXT NOT NULL, head TEXT, tail TEXT, size INTEGER NOT NULL, PRIMARY KEY(owner,slot)) STRICT;
      CREATE TABLE IF NOT EXISTS many_refs(owner TEXT NOT NULL, slot TEXT NOT NULL, id TEXT NOT NULL, previous TEXT, next TEXT, body TEXT NOT NULL, PRIMARY KEY(owner,slot,id)) STRICT;
      CREATE TABLE IF NOT EXISTS publications(owner TEXT NOT NULL, fact TEXT NOT NULL, PRIMARY KEY(owner,fact)) STRICT;
    `);
  }

  query(sql) {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  readHead(owner) {
    this.stats.metadataReads++;
    const row = this.query('SELECT revision,body,digest FROM heads WHERE owner=?').get(owner);
    if (!row) return undefined;
    assert.equal(hash(row.body), row.digest, 'Corrupt head');
    const head = JSON.parse(row.body);
    assert.equal(head.revision, row.revision);
    assert.equal(head.identity.contextId, owner);
    assert.equal(head.format, 'fact-head-study@1');
    return head;
  }

  factMeta(id) {
    this.stats.metadataReads++;
    return this.query('SELECT id,owner,kind,codec,digest FROM facts WHERE id=?').get(id);
  }

  relation(owner, child) {
    this.stats.metadataReads++;
    const row = this.query('SELECT body FROM relations WHERE owner=? AND child=?').get(owner, child);
    return row && JSON.parse(row.body);
  }

  visibleFact(owner, id) {
    this.stats.metadataReads++;
    return this.query('SELECT f.id,f.owner,f.kind,f.codec,f.digest FROM facts f JOIN publications p ON p.fact=f.id WHERE p.owner=? AND f.id=?').get(owner, id);
  }

  #slot(owner, slot, kind) {
    assert.ok(typeof slot === 'string' && slot.length > 0);
    this.stats.metadataReads++;
    let row = this.query('SELECT kind,head,tail,size FROM ref_slots WHERE owner=? AND slot=?').get(owner, slot);
    if (row) assert.equal(row.kind, kind, 'Reference cardinality changed');
    else {
      this.query('INSERT INTO ref_slots VALUES (?,?,?,?,?,?)').run(owner, slot, kind, null, null, 0);
      row = { kind, head: null, tail: null, size: 0 };
    }
    return row;
  }

  #referenceEntry(owner, slot, id) {
    this.stats.metadataReads++;
    return this.query('SELECT id,previous,next,body FROM many_refs WHERE owner=? AND slot=? AND id=?').get(owner, slot, id);
  }

  #referenceEvent(owner, event) {
    const kind = event.type === 'ref' || event.type === 'ref-clear' ? 'single' : 'many';
    const slot = this.#slot(owner, event.slot, kind);
    if (event.type === 'ref') {
      checkReference(event.value, this.relation(owner, event.value.contextId), owner);
      this.query('INSERT INTO refs VALUES (?,?,?) ON CONFLICT(owner,slot) DO UPDATE SET body=excluded.body').run(owner, event.slot, pack(event.value));
      return;
    }
    if (event.type === 'ref-clear') {
      assert.equal(this.query('DELETE FROM refs WHERE owner=? AND slot=?').run(owner, event.slot).changes, 1, 'Missing single reference');
      return;
    }
    assert.ok(typeof event.id === 'string' && event.id.length > 0, 'Invalid reference occurrence');
    if (event.type === 'ref-add') {
      checkReference(event.value, this.relation(owner, event.value.contextId), owner);
      const next = event.before === null ? undefined : this.#referenceEntry(owner, event.slot, event.before);
      assert.ok(event.before === null || next, 'Missing reference insertion anchor');
      const previous = next ? next.previous : slot.tail;
      this.query('INSERT INTO many_refs VALUES (?,?,?,?,?,?)').run(owner, event.slot, event.id, previous, event.before, pack(event.value));
      if (previous !== null) assert.equal(this.query('UPDATE many_refs SET next=? WHERE owner=? AND slot=? AND id=?').run(event.id, owner, event.slot, previous).changes, 1, 'Missing reference predecessor');
      if (next) this.query('UPDATE many_refs SET previous=? WHERE owner=? AND slot=? AND id=?').run(event.id, owner, event.slot, next.id);
      this.query('UPDATE ref_slots SET head=?,tail=?,size=? WHERE owner=? AND slot=?').run(previous === null ? event.id : slot.head, next ? slot.tail : event.id, slot.size + 1, owner, event.slot);
      return;
    }
    assert.equal(event.type, 'ref-remove');
    const entry = this.#referenceEntry(owner, event.slot, event.id);
    assert.ok(entry, 'Missing reference occurrence');
    if (entry.previous !== null) assert.equal(this.query('UPDATE many_refs SET next=? WHERE owner=? AND slot=? AND id=?').run(entry.next, owner, event.slot, entry.previous).changes, 1, 'Missing reference predecessor');
    if (entry.next !== null) assert.equal(this.query('UPDATE many_refs SET previous=? WHERE owner=? AND slot=? AND id=?').run(entry.previous, owner, event.slot, entry.next).changes, 1, 'Missing reference successor');
    this.query('DELETE FROM many_refs WHERE owner=? AND slot=? AND id=?').run(owner, event.slot, event.id);
    this.query('UPDATE ref_slots SET head=?,tail=?,size=? WHERE owner=? AND slot=?').run(entry.previous === null ? entry.next : slot.head, entry.next === null ? entry.previous : slot.tail, slot.size - 1, owner, event.slot);
  }

  commit({ identity: owner, expected, input, state, stateCodec, point, status = 'active', delivery = null, events, facts }, fault = () => {}) {
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const prior = this.readHead(owner.contextId);
      assert.equal(prior?.revision ?? 0, expected, 'Revision conflict');
      if (prior) {
        assert.equal(prior.status, 'active', 'Terminal head cannot advance');
        assert.deepEqual(prior.identity, owner, 'Call identity changed');
        assert.equal(prior.input, input, 'Input fact changed');
      }
      checkIdentity(owner);
      assert.ok(['active', 'succeeded', 'failed'].includes(status));
      let factBytes = 0;
      const introduced = new Set();
      for (const row of facts) {
        assert.equal(hash(row.body), row.digest, 'Corrupt new fact');
        assert.ok(!introduced.has(row.id), 'Duplicate fact');
        introduced.add(row.id);
        // Identities are never reused, including same-content duplicates.
        this.query('INSERT INTO facts VALUES (?,?,?,?,?,?)').run(row.id, row.owner, row.kind, row.codec, row.digest, row.body);
        factBytes += bytes(row.body);
      }
      fault('facts');
      let cursor = prior?.cursor ?? 0;
      let chain = prior?.chain ?? emptyHash;
      let childCount = prior?.childCount ?? 0;
      let metadataBytes = 0;
      const logged = new Set();
      const dirtyRelations = new Map();
      for (const event of events) {
        if (event.type === 'fact' || event.type === 'link') {
          assert.ok(!logged.has(event.value.id), 'Fact introduction mismatch');
          assert.equal(introduced.has(event.value.id), event.type === 'fact', 'Fact publication mismatch');
          assert.deepEqual({ ...this.factMeta(event.value.id) }, event.value);
          this.query('INSERT INTO publications VALUES (?,?)').run(owner.contextId, event.value.id);
          logged.add(event.value.id);
        } else if (event.type === 'relation') {
          const next = event.value;
          assert.equal(next.identity.parentId, owner.contextId);
          const previous = this.relation(owner.contextId, next.identity.contextId);
          checkRelation(previous, next);
          if (!previous) assert.equal(next.identity.order, ++childCount, 'Missing child order');
          relationFacts(next, (id) => this.visibleFact(owner.contextId, id));
          dirtyRelations.set(next.identity.contextId, next);
          this.query('INSERT INTO relations VALUES (?,?,?,?) ON CONFLICT(owner,child) DO UPDATE SET body=excluded.body').run(owner.contextId, next.identity.contextId, next.identity.order, pack(next));
        } else if (['ref', 'ref-clear', 'ref-add', 'ref-remove'].includes(event.type)) {
          this.#referenceEvent(owner.contextId, event);
        } else assert.fail('Unknown event');
        const body = pack(event);
        const nextHash = hash(pack([chain, ++cursor, body]));
        this.query('INSERT INTO events VALUES (?,?,?,?,?)').run(owner.contextId, cursor, chain, nextHash, body);
        chain = nextHash;
        metadataBytes += bytes(body);
      }
      for (const id of introduced) assert.ok(logged.has(id), 'Unpublished fact rows');
      if (status !== 'failed') for (const relation of dirtyRelations.values()) assert.ok(relation.result !== 'failed' || relation.phase === 'handled', 'Unprocessed failure cannot form resumable head');
      factFor((id) => this.visibleFact(owner.contextId, id), input, owner.contextId, 'input');
      if (status === 'succeeded') factFor((id) => this.visibleFact(owner.contextId, id), delivery, owner.contextId, 'returned');
      else assert.equal(delivery, null);
      fault('events');
      const head = { format: 'fact-head-study@1', identity: owner, revision: expected + 1, input, point, state, stateCodec, status, delivery, cursor, chain, childCount };
      const body = pack(head);
      fault('before-head');
      this.query('INSERT INTO heads VALUES (?,?,?,?) ON CONFLICT(owner) DO UPDATE SET revision=excluded.revision,body=excluded.body,digest=excluded.digest').run(owner.contextId, head.revision, body, hash(body));
      fault('head');
      this.db.exec('COMMIT');
      committed = true;
      this.stats.commits++;
      this.stats.factsWritten += facts.length;
      this.stats.factBytesWritten += factBytes;
      this.stats.metadataEvents += events.length;
      this.stats.metadataBytesWritten += metadataBytes;
      this.stats.headBytesWritten += bytes(body);
      fault('committed');
      return { owner: owner.contextId, revision: head.revision, cursor, chain, headDigest: hash(body) };
    } finally {
      if (!committed) this.db.exec('ROLLBACK');
    }
  }

  // A cold restore revalidates the entire visible prefix. Process-local evidence
  // is never imported. Index tables are derived, and cross-checked, not authority.
  restore(owner, codecs) {
    const head = this.readHead(owner);
    assert.ok(head, 'Missing checkpoint');
    checkIdentity(head.identity);
    assert.ok(['active', 'succeeded', 'failed'].includes(head.status), 'Invalid head status');
    const stateCodec = codecs.get(head.stateCodec);
    assert.ok(stateCodec, 'Missing state codec');
    const state = stateCodec.decode(head.state);
    const values = new Map();
    const metadata = new Map();
    const relations = new Map();
    const refs = new Map();
    const refKinds = new Map();
    const manyRefs = new Map();
    let cursor = 0;
    let chain = emptyHash;
    let childCount = 0;
    for (const row of this.query('SELECT seq,previous,digest,body FROM events WHERE owner=? AND seq<=? ORDER BY seq').iterate(owner, head.cursor)) {
      this.stats.restoreEvents++;
      assert.equal(row.seq, ++cursor, 'Missing event');
      assert.equal(row.previous, chain, 'Broken event chain');
      assert.equal(row.digest, hash(pack([chain, cursor, row.body])), 'Corrupt event');
      chain = row.digest;
      const event = JSON.parse(row.body);
      if (event.type === 'fact' || event.type === 'link') {
        assert.ok(!metadata.has(event.value.id), 'Duplicate introduction');
        const stored = this.query('SELECT * FROM facts WHERE id=?').get(event.value.id);
        assert.ok(stored, 'Missing fact');
        const { body, ...meta } = stored;
        assert.deepEqual(meta, event.value, 'Fact metadata mismatch');
        assert.equal(hash(body), meta.digest, 'Corrupt fact body');
        const codec = codecs.get(meta.codec);
        assert.ok(codec, 'Incompatible codec');
        values.set(meta.id, codec.decode(body));
        metadata.set(meta.id, meta);
        this.stats.restoreFacts++;
        this.stats.oldBodyReads++;
      } else if (event.type === 'relation') {
        const next = event.value;
        assert.equal(next.identity.parentId, owner);
        const previous = relations.get(next.identity.contextId);
        checkRelation(previous, next);
        if (!previous) assert.equal(next.identity.order, ++childCount, 'Missing child order');
        relationFacts(next, (id) => metadata.get(id));
        relations.set(next.identity.contextId, next);
      } else if (event.type === 'ref') {
        referenceKind(refKinds, event.slot, 'single');
        checkReference(event.value, relations.get(event.value.contextId), owner);
        refs.set(event.slot, event.value);
      } else if (event.type === 'ref-clear') {
        referenceKind(refKinds, event.slot, 'single');
        assert.ok(refs.delete(event.slot), 'Missing single reference');
      } else if (event.type === 'ref-add') {
        referenceKind(refKinds, event.slot, 'many');
        checkReference(event.value, relations.get(event.value.contextId), owner);
        const list = manyRefs.get(event.slot) ?? new ReferenceList();
        list.add(event.id, event.value, event.before);
        manyRefs.set(event.slot, list);
      } else if (event.type === 'ref-remove') {
        referenceKind(refKinds, event.slot, 'many');
        assert.ok(manyRefs.get(event.slot)?.remove(event.id), 'Missing reference occurrence');
      } else assert.fail('Unknown restored event');
    }
    assert.equal(cursor, head.cursor, 'Missing event prefix');
    assert.equal(chain, head.chain, 'Head chain mismatch');
    assert.equal(childCount, head.childCount);
    if (head.status !== 'failed') for (const relation of relations.values()) assert.ok(relation.result !== 'failed' || relation.phase === 'handled', 'Unprocessed failure cannot restore');
    factFor((id) => metadata.get(id), head.input, owner, 'input');
    if (head.status === 'succeeded') factFor((id) => metadata.get(id), head.delivery, owner, 'returned');
    else assert.equal(head.delivery, null);
    const publications = this.query('SELECT fact FROM publications WHERE owner=?').all(owner);
    assert.equal(publications.length, metadata.size, 'Publication index mismatch');
    for (const row of publications) assert.ok(metadata.has(row.fact), 'Publication index mismatch');
    for (const [table, expected] of [
      ['relations', relations],
      ['refs', refs],
    ]) {
      const rows = this.query(`SELECT body FROM ${table} WHERE owner=?`).all(owner);
      assert.equal(rows.length, expected.size, 'Derived index mismatch');
      const actual =
        table === 'relations'
          ? this.query('SELECT child,position,body FROM relations WHERE owner=?')
              .all(owner)
              .map((row) => {
                const relation = JSON.parse(row.body);
                assert.equal(row.child, relation.identity.contextId, 'Derived child key mismatch');
                assert.equal(row.position, relation.identity.order, 'Derived child order mismatch');
                return [row.child, relation];
              })
          : this.query('SELECT slot,body FROM refs WHERE owner=?')
              .all(owner)
              .map((row) => [row.slot, JSON.parse(row.body)]);
      for (const [key, value] of actual) assert.deepEqual(value, expected.get(key), 'Derived index mismatch');
    }
    const slots = this.query('SELECT slot,kind,head,tail,size FROM ref_slots WHERE owner=?').all(owner);
    assert.equal(slots.length, refKinds.size, 'Reference slot index mismatch');
    let expectedEntries = 0;
    for (const slot of slots) {
      assert.equal(slot.kind, refKinds.get(slot.slot), 'Reference slot kind mismatch');
      const entries = manyRefs.get(slot.slot)?.entries() ?? [];
      assert.equal(slot.size, entries.length, 'Reference slot size mismatch');
      assert.equal(slot.head, entries[0]?.id ?? null, 'Reference head mismatch');
      assert.equal(slot.tail, entries.at(-1)?.id ?? null, 'Reference tail mismatch');
      expectedEntries += entries.length;
      for (const [index, entry] of entries.entries()) {
        const stored = this.#referenceEntry(owner, slot.slot, entry.id);
        assert.ok(stored, 'Missing reference index occurrence');
        assert.equal(stored.previous, entries[index - 1]?.id ?? null, 'Reference predecessor mismatch');
        assert.equal(stored.next, entries[index + 1]?.id ?? null, 'Reference successor mismatch');
        assert.deepEqual(JSON.parse(stored.body), entry.child, 'Reference body mismatch');
      }
    }
    assert.equal(this.query('SELECT count(*) count FROM many_refs WHERE owner=?').get(owner).count, expectedEntries, 'Reference index count mismatch');
    return { head, state, values, metadata, relations, refs, refKinds, manyRefs };
  }

  close() {
    this.db.close();
  }
}

export function stableCodec(values = new StableValues()) {
  return Object.freeze({ key: 'stable-value-study@1', encode: (value) => values.encode(values.own(value)), decode: (body) => values.decode(body) });
}
