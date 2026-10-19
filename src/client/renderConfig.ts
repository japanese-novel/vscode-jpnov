/**
 * Snapshots the `jpnov.layout.*` render settings (layout core + preview/paper slices) into the
 * wire shapes carried on `jpnov/renderFile` / `jpnov/build`. Read at default (resource-less) scope — one
 * window-global set of values, no folder overrides (mirrors lintConfig.ts). Raw values
 * are forwarded as-is; clamping / enum coercion is the server resolver's job. The `get`
 * fallbacks reference the single-source default constants (never fresh literals).
 */
import * as vscode from 'vscode';

import type { EdgeLineStyle } from '#/shared/compiler/chrome.ts';
import type { PaperOrientation, PaperSize } from '#/shared/compiler/geometry.ts';
import { BUILD_CHROME_DEFAULT, BUILD_PAPER_DEFAULT, PREVIEW_CHROME_DEFAULT } from '#/shared/config/settings.ts';
import type { DashMode, KinsokuMode, LayoutSettings, LinePitch } from '#/shared/config/types.ts';
import { LAYOUT_DEFAULT } from '#/shared/config/types.ts';
import type { HtmlSettings, PreviewSettings } from '#/shared/protocol.ts';

/** The shared layout core, snapshotted once for both wire shapes. */
function layoutSnapshot(c: vscode.WorkspaceConfiguration): LayoutSettings {
  return {
    charsPerLine: c.get<number>('jpnov.layout.charsPerLine', LAYOUT_DEFAULT.charsPerLine),
    linesPerPage: c.get<number>('jpnov.layout.linesPerPage', LAYOUT_DEFAULT.linesPerPage),
    linePitch: c.get<LinePitch>('jpnov.layout.linePitch', LAYOUT_DEFAULT.linePitch),
    fontFamily: c.get<string>('jpnov.layout.fontFamily', LAYOUT_DEFAULT.fontFamily),
    kinsoku: c.get<KinsokuMode>('jpnov.layout.kinsoku', LAYOUT_DEFAULT.kinsoku),
    // The one `jpnov.lint.*` key in the render snapshot: the dash choice also drives typesetting.
    dash: c.get<DashMode>('jpnov.lint.common.dash', LAYOUT_DEFAULT.dash),
  };
}

/** True when a settings change moves either snapshot: `jpnov.layout.*`, or the dash choice (the one lint key the snapshots carry). */
export function affectsRenderSettings(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration('jpnov.layout') || e.affectsConfiguration('jpnov.lint.common.dash');
}

export function buildPreviewSettings(): PreviewSettings {
  const c = vscode.workspace.getConfiguration();
  return {
    ...layoutSnapshot(c),
    lineNumbers: c.get<boolean>('jpnov.layout.preview.lineNumbers', PREVIEW_CHROME_DEFAULT.lineNumbers),
    edgeLine: c.get<EdgeLineStyle>('jpnov.layout.preview.edgeLine', PREVIEW_CHROME_DEFAULT.edgeLine),
  };
}

export function buildHtmlSettings(): HtmlSettings {
  const c = vscode.workspace.getConfiguration();
  return {
    ...layoutSnapshot(c),
    lineNumbers: c.get<boolean>('jpnov.layout.paper.lineNumbers', BUILD_CHROME_DEFAULT.lineNumbers),
    edgeLine: c.get<EdgeLineStyle>('jpnov.layout.paper.edgeLine', BUILD_CHROME_DEFAULT.edgeLine),
    paperSize: c.get<PaperSize>('jpnov.layout.paper.size', BUILD_PAPER_DEFAULT.paperSize),
    paperOrientation: c.get<PaperOrientation>('jpnov.layout.paper.orientation', BUILD_PAPER_DEFAULT.paperOrientation),
  };
}
