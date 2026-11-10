/** A host-owned entity. Registering access never transfers ownership or freezes entity state. */
export class Resource<Origin> {
  constructor(readonly origin: Origin) {
    Object.freeze(this);
  }
}
