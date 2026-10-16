/** The message of an `Error`, else the value as a string. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
