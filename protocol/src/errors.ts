export type RuntimeErrorDetail = null | boolean | number | string | RuntimeErrorDetail[] | { [key: string]: RuntimeErrorDetail };

/** Serializable error content embedded in records; not an exception instance or standalone record. */
export interface RuntimeErrorValue {
  code: string;
  message: string;
  name?: string;
  stack?: string;
  detail?: RuntimeErrorDetail;
  cause?: RuntimeErrorValue;
  errors?: RuntimeErrorValue[];
}

/** Scope and category of an unsuccessful invocation delivery; not a retry instruction. */
export interface InvocationFailureFact {
  readonly kind: 'exception' | 'error';
  readonly phase: 'setup' | 'execute' | 'receive' | 'handling' | 'control' | 'observation';
  readonly contextId: string;
  readonly contract?: string;
}
