import type { RecordBook } from '../container/book.js';
import { CompositeRecord } from '../composite.js';
import { InvocationRecord } from '../invocation/record.js';
import { InvocationBoundaryRecord } from '../invocation-boundary/record.js';
import { ResourceRecord } from '../resource/record.js';
import { checkRelation } from '../tree/relation.js';

/** Validate a saved forest as facts, including a prefix interrupted between recording writes. */
export function checkRestoredTree(book: RecordBook): void {
  const contexts = new Set<string>();
  const boundaries = new Map<string, { sequence: number; offsetMs: number; calls: Map<string, 'call' | 'return' | 'throw'> }>();
  const resources = new Map<string, { sequence: number; accesses: Map<string, string>; interactions: Map<string, string> }>();
  for (const record of book.values()) {
    const parent = record.parentId === undefined ? undefined : book.get(record.parentId);
    if (record.parentId !== undefined && !(parent instanceof CompositeRecord)) throw new Error('Stored record parent is missing or cannot contain children');
    if (parent instanceof CompositeRecord && !parent.childIds.includes(record.id)) throw new Error('Stored record parent does not reference its child');
    if (record instanceof CompositeRecord) {
      for (const childId of record.childIds) {
        const child = book.get(childId);
        if (!child || child.parentId !== record.id) throw new Error('Inconsistent stored child reference');
      }
    }
    checkRelation(record, parent as CompositeRecord<unknown> | undefined, book, 'restore');
    if (record instanceof InvocationRecord && 'contextId' in record) {
      const contextId = record.contextId as string;
      if (contexts.has(contextId) || book.get(contextId)) throw new Error('Stored invocation context identity conflicts');
      contexts.add(contextId);
      for (const relation of record.value.relationChanges) {
        const child = relation.childId === undefined ? undefined : book.get(relation.childId);
        if (child && (child.parentId !== record.id || !('contextId' in child) || child.contextId !== relation.identity.childContextId)) throw new Error('Stored child relation points to another invocation');
      }
    }
    if (record instanceof InvocationBoundaryRecord) {
      if (record.scopeId !== (record.executionId ?? record.callId)) throw new Error('Stored boundary has an inconsistent timing scope');
      const scope = boundaries.get(record.scopeId) ?? { sequence: 0, offsetMs: 0, calls: new Map() };
      if (record.sequence !== scope.sequence + 1 || record.offsetMs < scope.offsetMs) throw new Error('Stored boundary sequence does not advance');
      const prior = scope.calls.get(record.callId);
      if (record.value.type === 'call' ? prior !== undefined : prior !== 'call') throw new Error('Stored boundary does not follow its call');
      const call = book.get(record.callId)!;
      if (record.value.type === 'call' && record.callId !== record.scopeId && scope.calls.get(call.parentId!) !== 'call') throw new Error('Stored child boundary starts outside its parent work');
      if (record.value.type === 'call' && record.callId === record.scopeId && record.sequence !== 1) throw new Error('Stored work scope must start before its children');
      if (record.value.type !== 'call' && [...scope.calls].some(([id, state]) => state === 'call' && book.get(id)?.parentId === record.callId)) throw new Error('Stored parent boundary ends before its active child');
      scope.sequence = record.sequence;
      scope.offsetMs = record.offsetMs;
      scope.calls.set(record.callId, record.value.type);
      boundaries.set(record.scopeId, scope);
    }
    if (record instanceof ResourceRecord) {
      const scope = resources.get(record.parentId) ?? { sequence: 0, accesses: new Map(), interactions: new Map() };
      if (record.sequence !== scope.sequence + 1) throw new Error('Stored resource sequence does not advance');
      const key = JSON.stringify([record.supplyId, record.access]);
      if (record.phase === 'bound') {
        if (scope.accesses.has(key)) throw new Error('Stored resource access is already bound');
        scope.accesses.set(key, record.phase);
      } else if (record.phase === 'available' || record.phase === 'unavailable') {
        if (scope.accesses.get(key) !== 'bound') throw new Error('Stored resource access is not bound');
        scope.accesses.set(key, record.phase);
      } else if (record.phase === 'started') {
        if (scope.accesses.get(key) !== 'available' || scope.interactions.has(record.interactionId!)) throw new Error('Stored resource interaction is not available');
        scope.interactions.set(record.interactionId!, key);
      } else {
        if (scope.interactions.get(record.interactionId!) !== key) throw new Error('Stored resource interaction has not started');
        scope.interactions.delete(record.interactionId!);
      }
      scope.sequence = record.sequence;
      resources.set(record.parentId, scope);
    }
  }
}
