/**
 * The panel's file-creating dialogs, pure and vscode-free: the starter content of a new cover
 * or book, and the normalization that turns one typed path into a `.jpnov` / `.jpbook` path
 * from the book's folder.
 */
import { isAbsoluteLocation } from '../config/validate.ts';
import { pathSegments } from '../utils/uri.ts';
import { FENCE, HEADER, META_DEFAULTS, META_KEYS, metaLine, type MetaKey } from './jpbook.ts';

/**
 * Starter content of a cover file created from the panel: README's 応募用の表紙 sample,
 * verbatim (test/shared/book/create.test.ts pins both READMEs to it).
 */
export const COVER_TEMPLATE = '［＃５字下げ］［＃ここに「タイトル」の値を表示］\n' +
  '［＃７字下げ］［＃ここに「ペンネーム」の値を表示］\n' +
  '［＃７字下げ］全［＃縦中横］［＃ここに「総ページ数」の値を表示］［＃縦中横終わり］ページ\n' +
  '［＃７字下げ］４００字詰め原稿用紙換算［＃縦中横］［＃ここに「原稿用紙換算枚数」の値を表示］［＃縦中横終わり］枚\n';

/**
 * The metadata a book created from the panel starts with: the title from the file's stem, every
 * other key at its default, written out so the author sees what there is to edit.
 */
export function templateValues(stem: string): Record<MetaKey, string> {
  return { title: stem, ...META_DEFAULTS };
}

/** Starter content of a book created from the panel: the header line, {@link templateValues}, and the `---` the chapters follow. */
export function bookTemplate(stem: string): string {
  const values = templateValues(stem);
  const lines = [HEADER, ...META_KEYS.map((key) => metaLine(key, values[key])), FENCE];
  return `${lines.join('\n')}\n`;
}

/** Why a typed path is unusable; the command maps each code to a localized message. */
export type FileInputError = 'empty' | 'absolute' | 'badName';

/**
 * A typed path (`src/my-chapter`, either separator) normalized into a file path from the
 * book's folder: segments collapsed (`..` folded, a leading one kept), `suffix` appended when
 * missing (one already typed counts in any letter case and stays as typed), NFC. Rejects what
 * the `.jpbook` grammar or a filesystem would: absolute/home/scheme locations, and per-segment
 * the Windows-forbidden character set or leading/trailing dots and whitespace (dotfiles would
 * be invisible to the chapter picker).
 */
export function normalizeFileInput(
  raw: string,
  suffix: string,
): { ok: true; rel: string } | { ok: false; error: FileInputError } {
  const trimmed = raw.trim().normalize('NFC');
  if (trimmed === '') {
    return { ok: false, error: 'empty' };
  }
  if (trimmed.startsWith('~') || isAbsoluteLocation(trimmed)) {
    return { ok: false, error: 'absolute' };
  }
  const segments = pathSegments(trimmed);
  const last = segments.pop();
  if (last === undefined || last === '..') {
    return { ok: false, error: 'empty' };
  }
  const suffixed = last.toLowerCase().endsWith(suffix);
  const stem = suffixed ? last.slice(0, -suffix.length) : last;
  if (stem === '') {
    return { ok: false, error: 'empty' };
  }
  for (const part of [...segments, stem]) {
    if (part !== '..' && (/[\p{Cc}:*?"<>|]/u.test(part) || /^[\s.]|[\s.]$/u.test(part))) {
      return { ok: false, error: 'badName' };
    }
  }
  return { ok: true, rel: [...segments, suffixed ? last : last + suffix].join('/') };
}
