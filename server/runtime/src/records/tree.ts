import { isUndefined } from 'es-toolkit/predicate';
import type { RecordBook } from './container/book.js';
import type { BaseRecord } from './record.js';
import { CompositeRecord } from './composite.js';
import { replaceChildren, prepareAttachment } from './tree/access.js';
import { checkRelation } from './tree/relation.js';

/** Traverses the relations stored on records; owns no second node or edge collection. */
export class RecordTree {
  constructor(private readonly book: RecordBook) {}

  children(id: string): readonly BaseRecord<unknown>[] {
    const record = this.require(id);
    if (!(record instanceof CompositeRecord)) return [];
    return record.childIds.map((childId) => {
      const child = this.require(childId);
      if (child.parentId !== id) throw new Error('Inconsistent record parent');
      return child;
    });
  }

  /** Depth-first ownership order, not chronological event order. */
  descendants(id: string): readonly BaseRecord<unknown>[] {
    const result: BaseRecord<unknown>[] = [];
    const pending = [...this.children(id)].reverse();
    const visited = new Set([id]);
    for (let record = pending.pop(); record; record = pending.pop()) {
      if (visited.has(record.id)) throw new Error('Cyclic or duplicate record relation');
      visited.add(record.id);
      result.push(record);
      pending.push(...[...this.children(record.id)].reverse());
    }
    return result;
  }

  /** Follow direct record links; no Runtime membership registry. */
  root(id: string): BaseRecord<unknown> {
    let record = this.require(id);
    const visited = new Set([id]);
    while (!isUndefined(record.parentId)) {
      const parent = this.require(record.parentId);
      if (visited.has(parent.id)) throw new Error('Cyclic record relation');
      if (!(parent instanceof CompositeRecord) || !parent.childIds.includes(record.id)) throw new Error('Inconsistent record parent');
      visited.add(parent.id);
      record = parent;
    }
    return record;
  }

  /** Internal staging; registration is the only writer. */
  [prepareAttachment](record: BaseRecord<unknown>) {
    if (this.book.get(record.id)) throw new Error('Record ID already exists');
    if (record instanceof CompositeRecord && record.childIds.length) throw new Error('New composite record must have no children');
    const parent = isUndefined(record.parentId) ? undefined : this.require(record.parentId);
    if (parent && !(parent instanceof CompositeRecord)) throw new Error('Record parent cannot contain children');
    checkRelation(record, parent, this.book);
    if (!parent) return undefined;
    const previous = parent.childIds;
    if (previous.includes(record.id)) throw new Error('Record is already attached');
    const next = Object.freeze([...previous, record.id]);
    return {
      parent,
      commit: () => parent[replaceChildren](next),
      rollback: () => parent[replaceChildren](previous),
    };
  }

  private require(id: string): BaseRecord<unknown> {
    const record = this.book.get(id);
    if (!record) throw new Error('Record does not exist');
    return record;
  }
}
