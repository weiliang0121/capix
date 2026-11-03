export type RuntimeErrorDetail = null | boolean | number | string | RuntimeErrorDetail[] | { [key: string]: RuntimeErrorDetail };

/** Serializable diagnostic content for transport and optional records; not an exception instance. */
export interface RuntimeErrorValue {
  code: string;
  message: string;
  name?: string;
  stack?: string;
  detail?: RuntimeErrorDetail;
  cause?: RuntimeErrorValue;
  errors?: RuntimeErrorValue[];
}

/** Scope and diagnostic category of an unsuccessful delivery; kind alone grants neither reception nor retry. */
export interface InvocationFailureFact {
  readonly kind: 'exception' | 'error';
  readonly phase: 'setup' | 'execute' | 'receive' | 'handling' | 'control' | 'observation';
  readonly contextId: string;
  readonly contract?: string;
}
