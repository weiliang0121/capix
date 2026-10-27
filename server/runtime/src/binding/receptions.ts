import type { ChildContract, ReceptionDefinition, ReceptionRegistration } from '@capix/contracts';
import type { InvocationReceptionBinding } from '@capix/invocation';
import type { BoundChildren } from './children/bound.js';
import { originalReception } from './snapshot.js';

/** Fixed parent-local contracts; no activity, result or resource is stored here. */
export class BoundReceptions {
  readonly #entries = new Map<object, { readonly child: ChildContract; readonly binding: InvocationReceptionBinding }>();
  readonly #bindings: readonly InvocationReceptionBinding[];

  constructor(receptions: readonly ReceptionRegistration[], children: BoundChildren) {
    const bindings: InvocationReceptionBinding[] = [];
    for (const reception of receptions) {
      const original = originalReception(reception);
      if (this.#entries.has(original)) throw new Error('Duplicate parent reception contract');
      const value = reception.value;
      const check = value.check.bind(value);
      const binding: InvocationReceptionBinding = Object.freeze({
        position: bindings.length,
        childPosition: children.position(reception.child),
        check: (value: unknown) => {
          // Validators may return copies. Successful reception retains its actual value.
          const checked: unknown = check(value);
          if (checked && (typeof checked === 'object' || typeof checked === 'function') && 'then' in checked && typeof checked.then === 'function') {
            void Promise.resolve(checked).catch(() => undefined);
            throw new TypeError('Reception checks must return synchronously');
          }
        },
        codec: Object.freeze({ encode: value.encode.bind(value), decode: value.decode.bind(value) }),
      });
      this.#entries.set(original, Object.freeze({ child: reception.child, binding }));
      bindings.push(binding);
    }
    this.#bindings = Object.freeze(bindings);
  }

  require<Definition extends ChildContract, Value>(reception: ReceptionDefinition<NoInfer<Definition>, Value>, child: Definition): InvocationReceptionBinding {
    const entry = this.#entries.get(originalReception(reception));
    if (!entry) throw new Error('Reception contract is not registered by this parent');
    if (entry.child !== child) throw new Error('Reception contract belongs to a different child declaration');
    return entry.binding;
  }

  bindings(): readonly InvocationReceptionBinding[] {
    return this.#bindings;
  }
}
