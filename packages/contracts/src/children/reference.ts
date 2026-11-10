declare const childReferenceSignature: unique symbol;
/** Certified by this parent activity; the opaque identity does not grant action rights. */
export interface ChildReference<Definition = unknown> {
  readonly [childReferenceSignature]: Definition;
}
