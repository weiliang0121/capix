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
