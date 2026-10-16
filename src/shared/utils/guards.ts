/** Whether `value` is an object whose properties can be read: not null, not a primitive. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
