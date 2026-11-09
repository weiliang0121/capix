import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

// 这是“依次生成并发布几份内容”的业务状态，不是通用 Progress 或流程图引擎。
// 初始化正式登记各操作。调用只处理已有操作，不按文本猜测是不是新的业务。
export class ProgressStore {
  #state;
  #failure;

  constructor(inputs, targetId) {
    if (!Array.isArray(inputs) || inputs.some((input) => typeof input !== 'string' || !input.trim())) throw new TypeError('Expected nonempty publication prompts');
    if (typeof targetId !== 'string' || !targetId.trim()) throw new TypeError('Publication needs a fixed target identity');
    const id = randomUUID();
    this.#state = {
      id,
      revision: 0,
      targetId,
      items: inputs.map((input) => ({ id: randomUUID(), generation: { ownerId: id, id: randomUUID(), input }, publication: { id: randomUUID(), targetId }, acceptanceId: randomUUID() })),
    };
  }

  read() {
    return structuredClone(this.#state);
  }

  // 模拟一个独立、同步、权威的存储边界。before/after 分别是提交前失败/确认丢失。
  commit(kind, expectedRevision, next) {
    if (expectedRevision !== this.#state.revision || next.revision !== expectedRevision + 1 || next.id !== this.#state.id) throw new Error('Progress revision conflict');
    const failure = this.#failure?.kind === kind ? this.#failure : undefined;
    if (failure) this.#failure = undefined;
    if (failure?.timing === 'before') throw new PersistenceError(`progress.${kind}`, new Error('Injected failure before commit'));
    this.#state = structuredClone(next);
    if (failure?.timing === 'after') throw new PersistenceError(`progress.${kind}`, new Error('Injected lost commit acknowledgement'));
  }

  failNext(kind, timing) {
    if (!['attach', 'accept'].includes(kind) || !['before', 'after'].includes(timing)) throw new TypeError('Unknown progress fault point');
    this.#failure = { kind, timing };
  }

  dump() {
    return this.read();
  }

  // 示例只重开自己导出的可信 JSON，不是持久格式迁移或任意输入接纳接口。
  static restore(snapshot) {
    const store = new ProgressStore([], snapshot.targetId);
    store.#state = structuredClone(snapshot);
    return store;
  }
}

export function publicationOperation(item, feedback) {
  if (!item.reference || typeof feedback?.id !== 'string' || typeof feedback.payload !== 'string' || !feedback.payload.trim()) throw new Error('Publication requires a handed-off reference and complete feedback');
  return { ownerId: item.generation.ownerId, id: item.publication.id, targetId: item.publication.targetId, input: { text: feedback.payload, feedbackId: feedback.id, reference: structuredClone(item.reference) } };
}

export class PublicationProgress {
  #store;
  #generation;
  #archive;

  // 这些是宿主固定注入的核验端口，不是保存上次 Work，也不从资源端点里再次找资源。
  constructor(store, generation, archive) {
    if (store.read().targetId !== archive.id) throw new Error('Publication target identity cannot change when reopening progress');
    this.#store = store;
    this.#generation = generation;
    this.#archive = archive;
  }

  read() {
    return this.#store.read();
  }

  attach({ itemId, expectedRevision, reference }) {
    const state = this.read();
    const item = this.#item(state, itemId);
    const established = this.#generation.find(item.generation);
    if (!established || !isDeepStrictEqual(established, reference)) throw new Error('Handoff does not belong to the registered generation operation');
    if (item.reference) {
      if (!isDeepStrictEqual(item.reference, reference)) throw new Error('Handoff cannot be replaced');
      return state; // 同一交接已提交，包括上次提交确认丢失的情况。
    }
    this.#requireCurrent(state, item);
    item.reference = structuredClone(reference);
    state.revision++;
    this.#store.commit('attach', expectedRevision, state);
    return this.read();
  }

  accept({ itemId, expectedRevision, changeId, receipt }) {
    const state = this.read();
    const item = this.#item(state, itemId);
    if (changeId !== item.acceptanceId) throw new Error('Acceptance identity does not match the registered change');
    if (item.acceptance) {
      if (!isDeepStrictEqual(item.acceptance.receipt, receipt)) throw new Error('An accepted change cannot acquire different evidence');
      return state; // 重复确认原接纳，不再次推进修订或依赖外部仍在线。
    }
    this.#requireCurrent(state, item);
    if (!item.reference || !isDeepStrictEqual(this.#generation.find(item.generation), item.reference)) throw new Error('Acceptance requires the correct formal handoff');
    const result = this.#generation.read(item.reference);
    if (result.kind !== 'received') throw new Error('Generation feedback is not confirmed');
    const operation = publicationOperation(item, result.feedback);
    // Receipt 是可序列化引用，不是可信类型品牌。目标实体重新核验真实效果。
    this.#archive.verify(operation, receipt);
    item.acceptance = { changeId, feedbackId: result.feedback.id, receipt: structuredClone(receipt) };
    state.revision++;
    this.#store.commit('accept', expectedRevision, state);
    return this.read();
  }

  #item(state, id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item) throw new Error('Unknown publication item');
    return item;
  }

  #requireCurrent(state, item) {
    if (state.items.find((entry) => !entry.acceptance) !== item) throw new Error('This business requires the previous publication to be accepted first');
  }
}
