import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

function fixedOperation(operation) {
  const value = structuredClone(operation);
  if (!value || Array.isArray(value) || !isDeepStrictEqual(Object.keys(value).sort(), ['id', 'input', 'ownerId', 'targetId']) || typeof value.ownerId !== 'string' || !value.ownerId || typeof value.id !== 'string' || !value.id || typeof value.targetId !== 'string' || !value.targetId) throw new TypeError('Invalid publication operation identity');
  const input = value.input;
  if (!input || Array.isArray(input) || !isDeepStrictEqual(Object.keys(input).sort(), ['feedbackId', 'reference', 'text']) || typeof input.text !== 'string' || typeof input.feedbackId !== 'string' || !input.feedbackId) throw new TypeError('Invalid publication input');
  const reference = input.reference;
  if (!reference || Array.isArray(reference) || !isDeepStrictEqual(Object.keys(reference).sort(), ['contract', 'id']) || typeof reference.id !== 'string' || !reference.id || typeof reference.contract !== 'string' || !reference.contract) throw new TypeError('Invalid publication interaction reference');
  return value;
}

// 只模拟本例目标实体的权威存储边界，并不是真实数据库。
// 正文就在 operation.input.text 中；正文与凭据必须作为同一 entry 提交。
export class ArchiveStore {
  #state = { id: randomUUID(), entries: [] };
  #available = true;
  #failure;

  get id() {
    return this.#state.id;
  }

  confirm(operation) {
    const fixed = fixedOperation(operation);
    if (fixed.targetId !== this.#state.id) throw new Error('Publication target does not match this archive');
    if (!this.#available) return { status: 'unknown' };
    const entry = this.#state.entries.find((entry) => entry.operation.ownerId === fixed.ownerId && entry.operation.id === fixed.id);
    if (!entry) return { status: 'not-applied' };
    if (!isDeepStrictEqual(entry.operation, fixed)) throw new Error('Publication operation input cannot change');
    return { status: 'confirmed', receipt: structuredClone(entry.receipt) };
  }

  commit(operation) {
    const fixed = fixedOperation(operation);
    // 存储提交本身复核唯一依据；调用方之前的查询不替代提交边界的约束。
    const confirmation = this.confirm(fixed);
    if (confirmation.status === 'confirmed') return confirmation.receipt;
    if (confirmation.status === 'unknown') throw new PersistenceError('archive.publish', new Error('Publication authority is unavailable'));
    const failure = this.#failure;
    this.#failure = undefined;
    if (failure === 'before') throw new PersistenceError('archive.publish', new Error('Injected failure before commit'));
    const receipt = { targetId: this.#state.id, ownerId: fixed.ownerId, operationId: fixed.id, entryId: randomUUID() };
    this.#state = { id: this.#state.id, entries: [...this.#state.entries, { operation: fixed, receipt }] };
    if (failure === 'after') throw new PersistenceError('archive.publish', new Error('Injected lost commit acknowledgement'));
    return structuredClone(receipt);
  }

  failNext(timing) {
    if (timing !== 'before' && timing !== 'after') throw new TypeError('Unknown archive fault point');
    this.#failure = timing;
  }

  setAvailable(available) {
    if (typeof available !== 'boolean') throw new TypeError('Expected archive availability');
    this.#available = available;
  }

  dump() {
    return structuredClone(this.#state);
  }

  // 宿主用导出的可信 JSON 重开存储；不恢复故障注入或模拟连接状态。
  static restore(snapshot) {
    const value = structuredClone(snapshot);
    if (!value || Array.isArray(value) || typeof value.id !== 'string' || !value.id || !Array.isArray(value.entries)) throw new TypeError('Invalid archive snapshot');
    const store = new ArchiveStore();
    const entries = [];
    for (const entry of value.entries) {
      const operation = fixedOperation(entry.operation);
      if (operation.targetId !== value.id) throw new TypeError('Invalid archive operation target');
      const receipt = entry.receipt;
      if (!receipt || Array.isArray(receipt) || !isDeepStrictEqual(Object.keys(receipt).sort(), ['entryId', 'operationId', 'ownerId', 'targetId']) || receipt.targetId !== value.id || receipt.ownerId !== operation.ownerId || receipt.operationId !== operation.id || typeof receipt.entryId !== 'string' || !receipt.entryId) throw new TypeError('Invalid archive receipt');
      if (entries.some((previous) => (previous.operation.ownerId === operation.ownerId && previous.operation.id === operation.id) || previous.receipt.entryId === receipt.entryId)) throw new Error('Duplicate archive entry');
      entries.push({ operation, receipt });
    }
    store.#state = { id: value.id, entries };
    return store;
  }
}

export class PublicationArchive {
  #store;

  constructor(store) {
    if (!(store instanceof ArchiveStore)) throw new TypeError('Expected an ArchiveStore');
    this.#store = store;
  }

  get id() {
    return this.#store.id;
  }

  confirm(operation) {
    return this.#store.confirm(operation);
  }

  publish(operation) {
    const fixed = fixedOperation(operation);
    const confirmation = this.confirm(fixed);
    if (confirmation.status === 'confirmed') return confirmation.receipt;
    if (confirmation.status === 'unknown') throw new PersistenceError('archive.publish', new Error('Publication authority is unavailable'));
    return this.#store.commit(fixed);
  }

  verify(operation, receipt) {
    // Receipt 不是可信品牌；只由当前目标存储确认它对应的真实正文与操作。
    const confirmation = this.confirm(operation);
    if (confirmation.status === 'unknown') throw new PersistenceError('archive.verify', new Error('Publication authority is unavailable'));
    if (confirmation.status !== 'confirmed' || !isDeepStrictEqual(confirmation.receipt, receipt)) throw new Error('Receipt does not confirm this publication');
    return confirmation.receipt;
  }
}
