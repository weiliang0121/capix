import type { InteractionReference } from '@weiliang0121/capix-interaction';

/** A failed local read retains the exchange reference; it never authorizes another send. */
export class ModelReplyPending extends Error {
  readonly reference: InteractionReference;

  constructor(reference: InteractionReference) {
    super('Model reply is still pending; read the same interaction later');
    this.name = 'ModelReplyPending';
    this.reference = Object.freeze({ id: reference.id, contract: reference.contract });
  }
}
