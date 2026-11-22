import { systemInspection } from '#engine';

/** Trusted engine predicates. None may read properties, invoke traps or mutate the inspected value. */
export interface ObjectInspection {
  isOpaqueObject(value: unknown): boolean;
  isNativeError(value: unknown): boolean;
  isPromise(value: unknown): boolean;
}

let installed: Readonly<ObjectInspection> | undefined = systemInspection;
let source: ObjectInspection | undefined = systemInspection;
let authorProvidesPlainObjects = false;
const intrinsicErrorBrand = (Error as ErrorConstructor & { isError?(value: unknown): boolean }).isError;

/** Use only when the host controls all inputs to object inspection. Native checks always take precedence. */
export function useAuthorProvidedPlainObjects(): void {
  if (!installed) authorProvidesPlainObjects = true;
}

export function installObjectInspection(inspection: ObjectInspection): void {
  if (!inspection || typeof inspection !== 'object') throw new TypeError('An object inspection adapter is required');
  if (inspection === source) return;
  if (installed || authorProvidesPlainObjects) throw new Error('The CAPiX object inspection policy is already fixed');
  const { isOpaqueObject, isNativeError, isPromise } = inspection;
  if (typeof isOpaqueObject !== 'function' || typeof isNativeError !== 'function' || typeof isPromise !== 'function') throw new TypeError('Object inspection requires opaque object, native error and Promise predicates');
  installed = Object.freeze({ isOpaqueObject: isOpaqueObject.bind(inspection), isNativeError: isNativeError.bind(inspection), isPromise: isPromise.bind(inspection) });
  source = inspection;
}

function predicates(): Readonly<ObjectInspection> {
  if (!installed) {
    if (authorProvidesPlainObjects) throw new Error('This strict brand check requires an engine predicate on this platform');
    throw new Error('CAPiX requires a host object inspection adapter on this platform. For author-controlled inputs, select useAuthorProvidedPlainObjects() during app startup.');
  }
  return installed;
}

function objectLike(value: unknown): boolean {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/** In author-provided mode the producer is responsible for excluding proxies and opaque host objects. */
export function isOpaqueObject(value: unknown): boolean {
  if (!objectLike(value) || authorProvidesPlainObjects) return false;
  return predicates().isOpaqueObject(value);
}

export function isNativeError(value: unknown): value is Error {
  if (!objectLike(value)) return false;
  if (!installed && intrinsicErrorBrand) return intrinsicErrorBrand(value);
  return predicates().isNativeError(value);
}

/** Recognizes errors only where the engine supplies a real brand check. */
export function isKnownNativeError(value: unknown): value is Error {
  if (authorProvidesPlainObjects && !intrinsicErrorBrand) return false;
  return isNativeError(value);
}

export function isPromise(value: unknown): value is Promise<unknown> {
  return objectLike(value) && predicates().isPromise(value);
}

/** Only identifies promises authenticated by an engine. Validate synchronous results independently. */
export function isKnownPromise(value: unknown): value is Promise<unknown> {
  if (authorProvidesPlainObjects) return false;
  return isPromise(value);
}
