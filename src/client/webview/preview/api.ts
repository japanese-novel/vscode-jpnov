/**
 * The preview bundle's one `acquireVsCodeApi()` call: the workbench throws on a second call in
 * the same document, so every module of the bundle shares this instance.
 */
export const api = acquireVsCodeApi();
