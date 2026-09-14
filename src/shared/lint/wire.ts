/**
 * Which `jpnov.lint.*` values ride the wire to the vscode-free server: only enabled rules, i.e. a
 * `true` boolean, a numeric threshold or a mode other than `off`; anything else is omitted, and the
 * server treats an absent key as off. Shared by the client's settings snapshot and the website.
 */
export function lintWireValue(value: unknown): boolean | number | string | undefined {
  return value === true || typeof value === 'number' || (typeof value === 'string' && value !== 'off') ? value : undefined;
}
