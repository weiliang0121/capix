import { RuntimeContext } from './context.js';

export interface AttemptDeclaration {
  phase: 'before' | 'commit' | 'after';
  source: string;
  caller: string;
  callee: string;
}

export class AttemptContext<I = unknown, O = unknown> extends RuntimeContext<I, O> {
  readonly declaration: Readonly<AttemptDeclaration>;

  constructor(
    readonly operationId: string,
    declaration: AttemptDeclaration,
    input: I,
  ) {
    super(input);
    this.declaration = Object.freeze({ ...declaration });
    Object.freeze(this);
  }

  get phase(): AttemptDeclaration['phase'] {
    return this.declaration.phase;
  }
}
