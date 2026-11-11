import { ResourcePortError } from './errors.js';
import type { ResourceActivity, ResourceOperationDescription } from './activity.js';
import type { ResourceOperation } from './methods.js';
import type { OperationOptions, OperationResult } from '@weiliang0121/capix-contracts';

export interface ResourceOperationSource {
  readonly offerId: string;
  readonly access: string;
  readonly supplyId: string;
}

/** A fixed resource label for a precise adapter; it owns no window or operation lifecycle. */
export class ResourceEndpointActivity {
  constructor(
    private readonly activity: ResourceActivity,
    private readonly source: ResourceOperationSource,
  ) {
    Object.freeze(this);
  }
  get access(): string {
    return this.source.access;
  }
  get supplyId(): string {
    return this.source.supplyId;
  }
  get origin(): { readonly contextId: string } | undefined {
    const owner = this.activity.owner;
    return owner ? Object.freeze({ contextId: owner.contextId }) : undefined;
  }
  validate(): void {
    this.activity.validate();
  }
  reception(): Readonly<{ parentContextId: string; childContextId: string }> {
    this.validate();
    try {
      if (!this.activity.owner?.reception) throw new ResourcePortError('Fixed operations require a parent reception binding');
      return this.activity.owner.reception();
    } catch (error) {
      this.rejectPort(error, 'Resource reception provenance failed');
    }
  }
  bound(): void {
    this.activity.publish(this.source, 'bound', () => null);
  }
  available(describe: () => unknown): void {
    this.activity.publish(this.source, 'available', describe);
  }
  unavailable(error: unknown): void {
    this.activity.publish(this.source, 'unavailable', () => ({ error: this.activity.describe(error) }));
  }
  operate<Output, Delta = never, const Options extends OperationOptions<Output, unknown, unknown, Delta> = {}>(action: string, detail: ResourceOperationDescription<Output>, execute: (operation: ResourceOperation<Delta>) => Output | PromiseLike<Output>, options?: Options): Promise<OperationResult<Output, Options>> {
    return this.activity.operate(this.source, action, detail, execute, options);
  }
  runSync<Output>(action: string, detail: ResourceOperationDescription<NoInfer<Output>>, execute: (operation: ResourceOperation) => Output): Output {
    return this.activity.runSync(this.source, action, detail, execute);
  }
  runAsync<Output>(action: string, detail: ResourceOperationDescription<Output>, execute: () => Promise<Output>): Promise<Output> {
    return this.activity.operate(this.source, action, detail, execute);
  }
  private rejectPort(error: unknown, message: string): never {
    this.activity.rejectPort(error, message);
  }
}
