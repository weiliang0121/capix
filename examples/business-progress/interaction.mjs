import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { Interaction, Interactions } from '@weiliang0121/capix-interaction';

function nonempty(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be a nonempty string`);
  return value;
}

function fields(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) throw new TypeError(`Expected fields: ${names.join(', ')}`);
}

function requestOf(operation) {
  return GenerationInteraction.request({ ownerId: operation?.ownerId, operationId: operation?.id, input: operation?.input });
}

function operationKey(request) {
  return JSON.stringify([request.ownerId, request.operationId]);
}

export const GenerationInteraction = Object.freeze({
  key: 'capix.example.business-progress.generation.v1',
  request(value) {
    fields(value, ['ownerId', 'operationId', 'input']);
    return Object.freeze({ ownerId: nonempty(value.ownerId, 'ownerId'), operationId: nonempty(value.operationId, 'operationId'), input: nonempty(value.input, 'input') });
  },
  reply(value) {
    return nonempty(value, 'reply');
  },
});

/** 示例的单存储：交互状态及事项索引一起提交；不证明数据库原子性或跨进程发送恢复。 */
export class InteractionJournal {
  #saved = { interactions: new Map(), links: new Map() };
  #failure;

  failNext(point) {
    if (!['create:before', 'create:after', 'started:before', 'started:after', 'find', 'read'].includes(point)) throw new TypeError(`Unknown journal failure point: ${point}`);
    this.#failure = point;
  }

  find(operation) {
    const request = requestOf(operation);
    this.#fail('find');
    const reference = this.#saved.links.get(operationKey(request));
    if (!reference) return undefined;
    const state = this.#saved.interactions.get(reference.id);
    if (!state || state.contract !== reference.contract || operationKey(state.request) !== operationKey(request)) throw new PersistenceError('generation.find', new Error('Invalid saved operation link'));
    if (state.request.input !== request.input) throw new RuntimeError('GENERATION_INPUT_CONFLICT', 'The same operation cannot change its fixed generation input');
    return reference;
  }

  persistence() {
    return Object.freeze({
      create: (state) => this.#create(state),
      commit: (change) => this.#commit(change),
      read: (id) => {
        this.#fail('read');
        return this.#saved.interactions.get(id);
      },
    });
  }

  dump() {
    return JSON.parse(JSON.stringify({ version: 1, interactions: [...this.#saved.interactions.values()], links: [...this.#saved.links].map(([key, reference]) => ({ ownerId: JSON.parse(key)[0], operationId: JSON.parse(key)[1], reference })) }));
  }

  static restore(dump) {
    fields(dump, ['version', 'interactions', 'links']);
    if (dump.version !== 1 || !Array.isArray(dump.interactions) || !Array.isArray(dump.links)) throw new TypeError('Invalid interaction journal dump');
    const journal = new InteractionJournal();
    const interactions = new Map();
    const links = new Map();
    const linked = new Set();
    for (const value of dump.interactions) {
      // 使用公开恢复接纳，保留内核的固定值及 revision 检查，不恢复发送者。
      const state = Interaction.restore(value, { contract: GenerationInteraction }).exportState();
      if (interactions.has(state.id)) throw new TypeError('Duplicate saved interaction');
      interactions.set(state.id, state);
    }
    for (const link of dump.links) {
      fields(link, ['ownerId', 'operationId', 'reference']);
      fields(link.reference, ['id', 'contract']);
      nonempty(link.ownerId, 'ownerId');
      nonempty(link.operationId, 'operationId');
      const state = interactions.get(link.reference.id);
      if (!state || state.contract !== link.reference.contract || state.request.ownerId !== link.ownerId || state.request.operationId !== link.operationId) throw new TypeError('Saved operation link does not match its interaction');
      const key = operationKey(link);
      if (links.has(key) || linked.has(state.id)) throw new TypeError('Duplicate saved operation link');
      links.set(key, Object.freeze({ ...link.reference }));
      linked.add(state.id);
    }
    if (linked.size !== interactions.size) throw new TypeError('Every saved interaction must have its operation link');
    journal.#saved = { interactions, links };
    return journal;
  }

  #create(value) {
    const state = Interaction.restore(value, { contract: GenerationInteraction }).exportState();
    if (state.revision !== 0 || state.delivery !== 'prepared') throw new TypeError('A new interaction must be prepared');
    const key = operationKey(state.request);
    if (this.#saved.interactions.has(state.id) || this.#saved.links.has(key)) throw new Error('Interaction or operation already exists');
    this.#fail('create:before');
    const interactions = new Map(this.#saved.interactions);
    const links = new Map(this.#saved.links);
    interactions.set(state.id, state);
    links.set(key, Object.freeze({ id: state.id, contract: state.contract }));
    // 一次替换模拟一个存储事务；状态和索引之间没有可注入的半提交窗口。
    this.#saved = { interactions, links };
    this.#fail('create:after');
  }

  #commit({ expectedRevision, state: value }) {
    const state = Interaction.restore(value, { contract: GenerationInteraction }).exportState();
    const previous = this.#saved.interactions.get(state.id);
    if (!previous || previous.revision !== expectedRevision || state.revision !== expectedRevision + 1) throw new Error('Interaction revision conflict');
    if (previous.contract !== state.contract || operationKey(previous.request) !== operationKey(state.request) || previous.request.input !== state.request.input) throw new Error('Cannot change a fixed interaction request');
    if (previous.delivery === 'started' && state.delivery !== 'started') throw new Error('Cannot rewind interaction delivery');
    if ((previous.feedback && JSON.stringify(previous.feedback) !== JSON.stringify(state.feedback)) || (previous.failure && JSON.stringify(previous.failure) !== JSON.stringify(state.failure))) throw new Error('Cannot replace saved interaction facts');
    const starting = previous.delivery === 'prepared' && state.delivery === 'started';
    if (starting) this.#fail('started:before');
    const interactions = new Map(this.#saved.interactions);
    interactions.set(state.id, state);
    this.#saved = { interactions, links: this.#saved.links };
    if (starting) this.#fail('started:after');
  }

  #fail(point) {
    if (this.#failure !== point) return;
    this.#failure = undefined;
    throw new PersistenceError(`generation.${point}`, new Error(`Injected journal failure: ${point}`));
  }
}

/** 事项引用始终来自日志；调用局部返回值不是唯一的交接依据。 */
export class GenerationGateway {
  #journal;
  #channel;

  constructor(journal, interactions) {
    this.#journal = journal;
    this.#channel = interactions.bind(GenerationInteraction);
  }

  find(operation) {
    return this.#journal.find(operation);
  }

  establish(operation) {
    const request = requestOf(operation);
    const existing = this.#journal.find(operation);
    if (existing) return existing;
    // 查找失败直接抛出。仅本存储明确不存在时建立，绝不把错误视为不存在。
    this.#channel.start(request);
    const reference = this.#journal.find(operation);
    if (!reference) throw new PersistenceError('generation.establish', new Error('The established interaction has no saved operation link'));
    return reference;
  }

  read(reference) {
    return this.#channel.read(reference);
  }
}

export function createGateway(journal, send) {
  if (typeof send !== 'function') throw new TypeError('Generation sender must be a function');
  const interactions = new Interactions().register(GenerationInteraction, { persistence: journal.persistence(), send: (request) => send(request.input) });
  return { gateway: new GenerationGateway(journal, interactions), interactions };
}
