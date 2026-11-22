import { isNativeError, isPromise, isProxy } from 'node:util/types';

export { randomUUID as systemRandomUUID } from 'node:crypto';

export const systemInspection = Object.freeze({ isOpaqueObject: isProxy, isNativeError, isPromise });
