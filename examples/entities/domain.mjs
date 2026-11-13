import { randomUUID } from 'node:crypto';
import { stableValue } from '@weiliang0121/capix-contracts';

// 这是示例自己的业务对象，没有 Entity 基类，也没有隐含持久化。
export class Plan {
  id = randomUUID();
  #material;

  constructor(value) {
    if (!value.title || !Number.isSafeInteger(value.completed) || value.completed < 0) throw new TypeError('Invalid plan');
    this.#material = stableValue({ basis: { id: this.id, revision: 0 }, value });
  }

  read() {
    return this.#material;
  }

  revise(value, expected) {
    if (expected.id !== this.id || expected.revision !== this.#material.basis.revision) throw new Error('Plan has changed');
    if (!value.title || !Number.isSafeInteger(value.completed) || value.completed < 0) throw new TypeError('Invalid plan');
    // 固定下一版再替换指向。旧材料继续有效，但本例不保存可查询的历史版本。
    this.#material = stableValue({ basis: { id: this.id, revision: this.#material.basis.revision + 1 }, value });
    return this.#material;
  }
}

// 普通追加材料不需要消息 role、记忆 topic 或来源列表。
// #region notes
export class Notes {
  id = randomUUID();
  #revision = 0;
  #items = new Map();

  get version() {
    return String(this.#revision);
  }

  keys() {
    return [...this.#items.keys()];
  }

  read(key) {
    if (!this.#items.has(key)) throw new RangeError('Note does not exist');
    return this.#items.get(key);
  }

  append(value) {
    if (!value.title || !value.text) throw new TypeError('A note requires title and text');
    const item = stableValue({ id: randomUUID(), value });
    this.#items.set(item.id, item);
    this.#revision++;
    return item;
  }
}
// #endregion notes
