import { BaseRecord } from './record.js';
import { replaceChildren } from './tree/access.js';

/** Direct child references only; no invocation state or execution policy. */
export abstract class CompositeRecord<Value> extends BaseRecord<Value> {
  #childIds: readonly string[] = Object.freeze([]);

  get childIds(): readonly string[] {
    return this.#childIds;
  }

  /** Package-internal write, committed only by record registration. */
  [replaceChildren](ids: readonly string[]): void {
    this.#childIds = ids;
  }

  override toJSON() {
    return { ...super.toJSON(), childIds: this.childIds };
  }
}
