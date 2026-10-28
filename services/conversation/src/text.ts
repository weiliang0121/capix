export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  return value;
}

export function requireText(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!/\S/.test(text)) throw new TypeError(`${label} must be nonblank text`);
  return text;
}
