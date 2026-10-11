/** One portable, canonical relative spelling, shared by request acceptance and actual access. */
export function isRelativeFilePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\:\u0000-\u001f\u007f]/u.test(value) && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}
