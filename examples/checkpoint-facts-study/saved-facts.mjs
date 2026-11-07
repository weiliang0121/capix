import assert from 'node:assert/strict';
import { runPointCheck } from './fact-call.mjs';
import { StableValues } from './stable.mjs';

const coordinate = (position, contract) => JSON.stringify([position, contract]);

// Experiment only: a synchronous query adapter over the existing fact owner.
// No second relation state, snapshot diff, or cache of arbitrary author checks.
// Each selected wrapper is a complete immutable snapshot and can outlive check;
// query ports and their opaque references cannot be used in a later check.
export class SavedFacts {
  #call;
  #definitions = new Map();
  #positions = new Map();
  #slots;
  #receptions = new Map();
  #values = new StableValues();
  #baseline = false;
  #basisRevision;
  #orderOffset;
  stats = { views: 0, wrappersBuilt: 0, relationReads: 0, bodyReads: 0, enumerationItems: 0, referenceItems: 0, referenceValidationItems: 0, baselineItems: 0, deltaItems: 0, singleItems: 0, relationBaselineItems: 0, relationDeltaItems: 0, selectionMetadata: 0, deltaEvents: 0, baselineValidations: 0, authorChecks: 0 };

  constructor(call, { definitions, slots = {}, receptions = [], orderOffset = 0 }) {
    this.#call = call;
    assert.ok(Number.isSafeInteger(orderOffset));
    this.#orderOffset = orderOffset;
    for (const item of definitions) {
      assert.ok(item.definition && typeof item.definition === 'object');
      assert.ok(typeof item.position === 'string' && typeof item.contract === 'string');
      const key = coordinate(item.position, item.contract);
      assert.ok(!this.#definitions.has(item.definition) && !this.#positions.has(key), 'Duplicate definition registration');
      const fixed = Object.freeze({ ...item });
      this.#definitions.set(item.definition, fixed);
      this.#positions.set(key, fixed);
    }
    this.#slots = Object.freeze(
      Object.fromEntries(
        Object.entries(slots).map(([name, slot]) => {
          assert.ok(['one', 'many'].includes(slot.cardinality), 'Unknown slot cardinality');
          assert.ok(this.#definitions.has(slot.definition), 'Unregistered slot definition');
          return [name, Object.freeze({ ...slot })];
        }),
      ),
    );
    for (const { reception, contract } of receptions) {
      assert.ok(!this.#receptions.has(reception), 'Duplicate reception alias');
      this.#receptions.set(reception, contract);
    }
  }

  #definition(value) {
    const registration = this.#definitions.get(value);
    assert.ok(registration, 'Unknown definition');
    return registration;
  }

  #slot(name, kind) {
    assert.ok(Object.hasOwn(this.#slots, name), 'Unknown reference slot');
    const slot = this.#slots[name];
    assert.ok(slot, 'Unknown reference slot');
    if (kind !== undefined) assert.equal(slot.cardinality, kind, 'Reference cardinality changed');
    return slot;
  }

  #target(slot, child) {
    this.stats.referenceValidationItems++;
    this.stats.relationReads++;
    const relation = this.#call.relation(child);
    const declaration = this.#definition(slot.definition);
    assert.equal(relation.identity.parentId, this.#call.identity.contextId, 'Foreign selection owner');
    assert.equal(relation.identity.position, declaration.position, 'Reference targets another definition');
    assert.equal(relation.identity.contract, declaration.contract, 'Reference targets another contract');
  }

  #validateRelations(baseline, changes) {
    const authenticate = (identity) => {
      assert.equal(identity.parentId, this.#call.identity.contextId, 'Foreign relation owner');
      assert.ok(this.#positions.has(coordinate(identity.position, identity.contract)), 'Unregistered child definition/contract');
    };
    // Every relation must belong to a bound declaration even if neither refs nor
    // the author select it. Only metadata is visited; no fact body or wrapper.
    if (baseline) {
      for (const identity of this.#call.relationIdentities()) {
        this.stats.relationBaselineItems++;
        authenticate(identity);
      }
    } else
      for (const event of changes.events) {
        if (event.type === 'relation' && event.value.phase === 'waiting') {
          this.stats.relationDeltaItems++;
          authenticate(event.value.identity);
        }
      }
  }

  #validateSelections(baseline, changes, required) {
    // Independent authentication runs even when the author never reads refs.
    // Source registration is instance-owned. A different source registry needs
    // a fresh baseline; point aliases can project it without changing sources.
    for (const entry of this.#call.referenceSlots()) {
      this.stats.selectionMetadata++;
      this.#slot(entry.slot, entry.kind === 'single' ? 'one' : 'many');
    }
    for (const [name, slot] of Object.entries(this.#slots)) {
      this.stats.selectionMetadata++;
      if (slot.cardinality === 'one') {
        const child = this.#call.referenceOf(name);
        if (!child && !required.has(name)) continue;
        assert.ok(child, 'Missing required single reference');
        this.stats.singleItems++;
        this.#target(slot, child);
      }
    }
    if (baseline) {
      this.stats.baselineValidations++;
      for (const [name, slot] of Object.entries(this.#slots))
        if (slot.cardinality === 'many') {
          for (const entry of this.#call.referenceEntries(name)) {
            this.stats.baselineItems++;
            this.#target(slot, entry.child);
          }
        }
      return;
    }
    // Changes are supplied by the owning fact ledger, not derived by comparing
    // full snapshots. Ordinary fact metadata is counted; no body is requested.
    const changed = new Map();
    for (const event of changes.events)
      if (event.type === 'ref-add') {
        this.#slot(event.slot, 'many');
        const ids = changed.get(event.slot) ?? new Set();
        ids.add(event.id);
        changed.set(event.slot, ids);
      }
    for (const [name, ids] of changed)
      for (const id of ids) {
        const entry = this.#call.referenceEntry(name, id);
        // An occurrence added then removed before saving is not selected.
        if (entry) {
          this.stats.deltaItems++;
          this.#target(this.#slot(name, 'many'), entry.child);
        }
      }
  }

  #projection(layout) {
    const projected = layout ?? Object.fromEntries(Object.keys(this.#slots).map((name) => [name, name]));
    const entries = Object.entries(projected);
    for (const [alias, source] of entries) {
      assert.ok(alias.length > 0 && typeof source === 'string', 'Invalid reference projection');
      this.#slot(source);
    }
    return Object.freeze(Object.fromEntries(entries));
  }

  #evaluate(point, state, check, layout) {
    const projected = this.#projection(layout);
    const baseline = !this.#baseline || this.#basisRevision !== this.#call.checkpointRevision;
    const changes = baseline ? undefined : this.#call.changes();
    if (changes) this.stats.deltaEvents += changes.events.length;
    this.#validateRelations(baseline, changes);
    this.#validateSelections(baseline, changes, new Set(Object.values(projected)));
    this.stats.views++;
    let active = true;
    const requireActive = () => assert.ok(active, 'Saved facts query window has ended');
    const byId = new Map();
    const references = new WeakMap();
    const slots = new Map();
    const relation = (child) => {
      requireActive();
      this.stats.relationReads++;
      return this.#call.relation(child);
    };
    const read = (id) => {
      this.stats.bodyReads++;
      return this.#call.factValue(id);
    };
    const wrap = (saved) => {
      requireActive();
      const existing = byId.get(saved.identity.contextId);
      if (existing) {
        assert.equal(existing.saved, saved, 'Relation changed during a synchronous check');
        return existing.fact;
      }
      assert.equal(saved.identity.parentId, this.#call.identity.contextId, 'Foreign relation owner');
      const declaration = this.#positions.get(coordinate(saved.identity.position, saved.identity.contract));
      assert.ok(declaration, 'Unregistered child definition/contract');
      const ref = Object.freeze({});
      const returned = saved.result === null ? undefined : Object.freeze(saved.result === 'succeeded' ? { status: 'succeeded', output: read(saved.output) } : { status: 'failed', diagnostic: read(saved.output) });
      let reception;
      if (['accepted', 'handled'].includes(saved.phase)) {
        this.stats.bodyReads++;
        this.stats.relationReads++;
        reception = Object.freeze({ status: saved.phase, value: this.#call.value(saved.identity) });
      } else reception = Object.freeze({ status: saved.phase === 'receiving' ? 'receiving' : 'pending' });
      const fact = Object.freeze({ ref, ...(saved.key === undefined ? {} : { key: saved.key }), parentRound: 1, order: saved.identity.order + this.#orderOffset, input: read(saved.input), returned, reception });
      const entry = Object.freeze({ saved, declaration, fact });
      byId.set(saved.identity.contextId, entry);
      references.set(ref, entry);
      this.stats.wrappersBuilt++;
      return fact;
    };
    const entry = (ref) => {
      requireActive();
      const found = ref && typeof ref === 'object' && references.get(ref);
      assert.ok(found, 'Unknown or foreign saved child reference');
      return found;
    };
    const received = (ref, contract, kind) => {
      const found = entry(ref);
      this.stats.relationReads++;
      this.#call.requireReception(found.saved.identity, this.#receptions.get(contract) ?? contract, kind);
      return found.fact.reception.value;
    };
    const children = Object.freeze({
      get: (ref) => entry(ref).fact,
      require: (definition, ref) => {
        const found = entry(ref);
        assert.equal(found.declaration.definition, definition, 'Reference belongs to another definition');
        return found.fact;
      },
      accepted: (ref, contract) => received(ref, contract, 'accepted'),
      handled: (ref, contract) => received(ref, contract, 'handled'),
      count: (definition) => {
        requireActive();
        this.stats.relationReads++;
        const fixed = definition === undefined ? undefined : this.#definition(definition);
        return this.#call.relationCount(fixed?.position, fixed?.contract);
      },
      latest: (definition) => {
        requireActive();
        this.stats.relationReads++;
        const fixed = this.#definition(definition);
        const saved = this.#call.latestRelation(fixed.position, fixed.contract);
        return saved && wrap(saved);
      },
      values: () => {
        requireActive();
        const all = this.#call.allRelations();
        this.stats.enumerationItems += all.length;
        return Object.freeze(all.map(wrap));
      },
      list: (definition, query) => {
        requireActive();
        const fixed = this.#definition(definition);
        const all = this.#call.allRelations();
        this.stats.enumerationItems += all.length;
        return Object.freeze(all.filter((saved) => saved.identity.position === fixed.position && saved.identity.contract === fixed.contract && (query?.parentRound === undefined || query.parentRound === 1)).map(wrap));
      },
      requireUnique: (definition, query) => {
        const found = children.list(definition, query);
        assert.equal(found.length, 1, 'Expected exactly one direct child fact');
        return found[0];
      },
    });
    const sourceOf = (alias, kind) => {
      assert.ok(Object.hasOwn(projected, alias), 'Unknown point reference alias');
      const source = projected[alias];
      this.#slot(source, kind);
      return source;
    };
    const select = (name, child) => {
      const slot = this.#slot(sourceOf(name));
      const saved = relation(child);
      const fixed = this.#definition(slot.definition);
      assert.equal(saved.identity.position, fixed.position, 'Reference targets another definition');
      assert.equal(saved.identity.contract, fixed.contract, 'Reference targets another contract');
      this.stats.referenceItems++;
      return wrap(saved);
    };
    const selections = Object.freeze({
      size: (name) => {
        requireActive();
        return this.#call.referenceSize(sourceOf(name, 'many'));
      },
      entry: (name, id) => {
        requireActive();
        const selected = this.#call.referenceEntry(sourceOf(name, 'many'), id);
        return selected && Object.freeze({ id: selected.id, child: select(name, selected.child) });
      },
      entries: (name) => {
        requireActive();
        return Object.freeze(this.#call.referenceEntries(sourceOf(name, 'many')).map((selected) => Object.freeze({ id: selected.id, child: select(name, selected.child) })));
      },
    });
    const selected = Object.create(null);
    for (const [name, source] of Object.entries(projected)) {
      const slot = this.#slot(source);
      Object.defineProperty(selected, name, {
        enumerable: true,
        get: () => {
          requireActive();
          if (!slots.has(name)) slots.set(name, slot.cardinality === 'many' ? Object.freeze(this.#call.referenceEntries(source).map((item) => select(name, item.child))) : select(name, this.#call.referenceOf(source)));
          return slots.get(name);
        },
      });
    }
    const facts = Object.freeze({
      get input() {
        requireActive();
        return readParent();
      },
      get initialInput() {
        requireActive();
        return readParent();
      },
      round: 1,
      references: Object.freeze(selected),
      selections,
      children,
      material: (id) => {
        requireActive();
        this.stats.bodyReads++;
        return this.#call.material(id);
      },
    });
    let inputRead = false;
    let input;
    const readParent = () => {
      if (!inputRead) {
        this.stats.bodyReads++;
        input = this.#call.input;
        inputRead = true;
      }
      return input;
    };
    try {
      this.stats.authorChecks++;
      runPointCheck((value) => check(value, facts, point), state, facts);
    } finally {
      active = false;
    }
  }

  save(point, state, { check = () => {}, ...options } = {}) {
    const receipt = this.#call.save(point, state, { ...options, check: (fixed) => this.#evaluate(point, fixed, check) });
    this.#baseline = true;
    this.#basisRevision = this.#call.checkpointRevision;
    return receipt;
  }

  check(point, state, check = () => {}) {
    return this.#call.inspect(() => this.#evaluate(point, this.#values.own(state), check));
  }

  saveProjection(point, state, layout, options = {}) {
    const prepared = this.#call.inspect(() => ({ layout: this.#projection(layout), options: Object.freeze({ ...options }) }));
    const { check = () => {}, ...fixedOptions } = prepared.options;
    const receipt = this.#call.save(point, state, { ...fixedOptions, check: (value) => this.#evaluate(point, value, check, prepared.layout) });
    this.#baseline = true;
    this.#basisRevision = this.#call.checkpointRevision;
    return receipt;
  }

  checkProjection(point, state, layout, check = () => {}) {
    return this.#call.inspect(() => this.#evaluate(point, this.#values.own(state), check, this.#projection(layout)));
  }
}
