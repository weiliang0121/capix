import assert from 'node:assert/strict';
import { hash } from './fact-store.mjs';
import { runPointCheck } from './fact-call.mjs';
import { SavedFacts } from './saved-facts.mjs';
import { StableValues } from './stable.mjs';

const format = 'point-facts-study@1';
const pointKey = (point) => JSON.stringify([point.name, point.version]);

// Isolated projection experiment. FactCall owns every relation and selection;
// this object owns only fixed point registrations and verification evidence.
export class PointFacts {
  #call;
  #facts;
  #values = new StableValues();
  #sources;
  #registered = new WeakMap();
  #points = new Map();
  #decodeState;
  #verifiedRevision;
  #coverage;

  constructor(call, { definitions, sources = {}, points, receptions = [], orderOffset = 0, decodeState } = {}) {
    this.#call = call;
    this.#facts = new SavedFacts(call, { definitions, slots: sources, receptions, orderOffset });
    const definitionsByObject = new Map(definitions.map((item) => [item.definition, item]));
    this.#sources = Object.freeze(
      Object.fromEntries(
        Object.entries(sources).map(([key, source]) => {
          const target = definitionsByObject.get(source.definition);
          assert.ok(key.length > 0 && target, 'Invalid selection source');
          return [key, Object.freeze({ cardinality: source.cardinality, position: target.position, contract: target.contract })];
        }),
      ),
    );
    const names = new Set();
    for (const original of points) {
      assert.ok(original && typeof original === 'object', 'Point must be an exact registered object');
      assert.ok(typeof original.name === 'string' && original.name.length > 0, 'Invalid point name');
      assert.ok(Number.isSafeInteger(original.version) && original.version > 0, 'Invalid point version');
      assert.ok(original.check === undefined || typeof original.check === 'function', 'Point check must be a function');
      assert.ok(!names.has(original.name), 'Duplicate point name');
      names.add(original.name);
      const entries = Object.entries(original.slots ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      const projection = Object.freeze(Object.fromEntries(entries));
      const layout = this.#values.own(
        entries.map(([alias, source]) => {
          assert.ok(alias.length > 0 && typeof source === 'string' && Object.hasOwn(this.#sources, source), 'Unknown point selection source');
          return { alias, source, ...this.#sources[source] };
        }),
      );
      const point = Object.freeze({ name: original.name, version: original.version });
      const key = pointKey(point);
      assert.ok(!this.#registered.has(original) && !this.#points.has(key), 'Duplicate point registration');
      const binding = Object.freeze({ original, point, layout, projection, check: original.check?.bind(original) ?? (() => {}) });
      this.#registered.set(original, binding);
      this.#points.set(key, binding);
    }
    this.#decodeState =
      decodeState ??
      ((head) => {
        assert.equal(head.stateCodec, 'reception-evidence-study@1', 'Unsupported experimental state codec');
        const decoded = this.#values.decode(head.state);
        assert.deepEqual(Object.keys(decoded).sort(), ['type', 'value']);
        assert.equal(decoded.type, 'plain', 'Point state must be plain material');
        return decoded.value;
      });
    if (call.checkpointRevision === 0) this.#verifiedRevision = 0;
    else this.#coverage = new Set();
  }

  #binding(point) {
    const binding = this.#registered.get(point);
    assert.ok(binding, 'Point is not this exact registration');
    return binding;
  }

  #ready() {
    assert.equal(this.#verifiedRevision, this.#call.checkpointRevision, 'Original saved checkpoint must be verified before continuing');
  }

  #selected(binding) {
    if (this.#coverage === undefined) return;
    for (const source of Object.values(binding.projection)) assert.ok(this.#coverage.has(source), 'Inactive selection was not part of the restored point; provide it explicitly');
  }

  #envelope(binding, state) {
    return this.#values.own({ format, point: binding.point, layout: binding.layout, state });
  }

  #checkEnvelope(binding, envelope, facts) {
    assert.deepEqual(Object.keys(envelope).sort(), ['format', 'layout', 'point', 'state']);
    assert.equal(envelope.format, format, 'Incompatible point envelope');
    assert.deepEqual(envelope.point, binding.point, 'Saved point version changed');
    assert.deepEqual(envelope.layout, binding.layout, 'Saved point layout changed');
    return binding.check(envelope.state, facts);
  }

  get stats() {
    return this.#facts.stats;
  }

  save(point, state, options = {}) {
    const prepared = this.#call.inspect(() => {
      this.#ready();
      const binding = this.#binding(point);
      this.#selected(binding);
      return { binding, envelope: this.#envelope(binding, state), options: Object.freeze({ ...options }) };
    });
    const { binding, envelope } = prepared;
    const receipt = this.#facts.saveProjection(binding.point.name, envelope, binding.projection, {
      ...prepared.options,
      check: (envelope, facts) => this.#checkEnvelope(binding, envelope, facts),
    });
    this.#verifiedRevision = this.#call.checkpointRevision;
    return receipt;
  }

  check(point, state) {
    const prepared = this.#call.inspect(() => {
      this.#ready();
      const binding = this.#binding(point);
      this.#selected(binding);
      return { binding, envelope: this.#envelope(binding, state) };
    });
    const { binding, envelope } = prepared;
    return this.#facts.checkProjection(binding.point.name, envelope, binding.projection, (fixed, facts) => this.#checkEnvelope(binding, fixed, facts));
  }

  verifySaved(head) {
    const decoded = this.#call.inspect(() => {
      const fixedHead = this.#values.own(head);
      assert.ok(this.#call.checkpointRevision > 0, 'No original checkpoint');
      assert.equal(hash(JSON.stringify(fixedHead)), this.#call.checkpointHeadDigest, 'Head is not the source-authenticated checkpoint');
      assert.deepEqual(fixedHead.identity, this.#call.identity, 'Saved owner changed');
      assert.equal(fixedHead.revision, this.#call.checkpointRevision, 'Saved revision changed');
      assert.equal(fixedHead.status, 'active', 'Terminal point cannot resume');
      assert.equal(this.#call.changes().events.length, 0, 'Cannot verify an old point against new pending facts or selections');
      let value;
      runPointCheck(() => (value = this.#decodeState(fixedHead)));
      const envelope = this.#values.own(value);
      assert.equal(envelope?.format, format, 'Incompatible point envelope');
      const binding = this.#points.get(pointKey(envelope.point ?? {}));
      assert.ok(binding, 'Unknown saved point or version');
      assert.equal(fixedHead.point, binding.point.name, 'Saved head and point disagree');
      return { binding, envelope, revision: fixedHead.revision, digest: this.#call.checkpointHeadDigest };
    });
    const { binding, envelope, revision, digest } = decoded;
    this.#facts.checkProjection(binding.point.name, envelope, binding.projection, (fixed, facts) => this.#checkEnvelope(binding, fixed, facts));
    assert.equal(this.#call.checkpointRevision, revision, 'Checkpoint changed while verifying its point');
    assert.equal(this.#call.checkpointHeadDigest, digest, 'Checkpoint changed while verifying its point');
    assert.equal(this.#call.changes().events.length, 0, 'Facts changed while verifying original point');
    this.#verifiedRevision = revision;
    // Residual inactive source entries remain stored, but do not become implicit
    // restored author choices. This is scope evidence, never action authority.
    this.#coverage = new Set(Object.values(binding.projection));
    return Object.freeze({ point: binding.original, state: envelope.state });
  }

  replaceSelection(source, selection) {
    const prepared = this.#call.inspect(() => {
      this.#ready();
      assert.ok(typeof source === 'string' && Object.hasOwn(this.#sources, source), 'Unknown selection source');
      const declaration = this.#sources[source];
      const fixed = this.#values.own(selection);
      assert.equal(Array.isArray(fixed), declaration.cardinality === 'many', 'Selection cardinality mismatch');
      const children = declaration.cardinality === 'many' ? fixed : fixed === undefined ? [] : [fixed];
      // Check the whole replacement before modifying even its first occurrence.
      // Proxy metaprogramming during fixing also stays inside the mutation lock.
      for (const child of children) {
        const relation = this.#call.relation(child);
        assert.equal(relation.identity.parentId, this.#call.identity.contextId, 'Foreign selection owner');
        assert.equal(relation.identity.position, declaration.position, 'Selection targets another definition');
        assert.equal(relation.identity.contract, declaration.contract, 'Selection targets another contract');
      }
      return { declaration, fixed, children };
    });
    const { declaration, fixed, children } = prepared;
    if (declaration.cardinality === 'one') {
      if (fixed === undefined) this.#call.clearReference(source);
      else this.#call.reference(source, fixed);
    } else {
      for (const entry of this.#call.referenceEntries(source)) this.#call.removeReference(source, entry.id);
      for (const child of children) this.#call.addReference(source, child);
    }
    this.#coverage?.add(source);
  }
}
