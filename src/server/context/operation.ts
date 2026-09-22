import { RuntimeContext } from './context.js';

/** Static invocation declaration; contains no record identity or input/output snapshots. */
export interface OperationDeclaration {
  operationInstanceId: string;
  operation: string;
  label: string;
  source: string;
  caller: string;
  callee: string;
}

export class OperationContext<I = unknown, O = unknown> extends RuntimeContext<I, O> {
  readonly declaration: Readonly<OperationDeclaration>;

  constructor(
    readonly executionId: string,
    declaration: OperationDeclaration,
    input: I,
    readonly parentOperationId?: string,
  ) {
    super(input);
    this.declaration = Object.freeze({ ...declaration });
    Object.freeze(this);
  }

  get operationInstanceId(): string {
    return this.declaration.operationInstanceId;
  }
}
