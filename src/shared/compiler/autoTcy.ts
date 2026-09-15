/**
 * 自動縦中横 (`jpnov.layout.autoTcy`): a range-aware source→source rewrite wrapping
 * every qualifying half-width pair in the spec's forward-ref postfix — `!?` becomes
 * `!?［＃「!?」は縦中横］` (https://www.aozora.gr.jp/annotation/etc.html#tatechu_yoko). It is
 * the ONE implementation all outputs share (the txt build materializes it, HTML/preview
 * re-tokenize it), so the compiler core only ever sees manual 縦中横; the editor buffer is
 * never rewritten.
 *
 * A pair qualifies iff it is a maximal [!?] run of length EXACTLY 2, in plain body text (a
 * TEXT token — never inside 《》/ruby bases/annotations), and not already 縦中横 (inside a
 * manual span, or immediately followed by its own postfix — the very shape this emits, so the
 * pass is idempotent). No line breaks are inserted, so data-line anchors and every
 * source-line-based diagnostic stay valid. Pure + vscode-free.
 */
import type { AutoTcyMode } from '../config/types.ts';
import { tokenize } from './tokenizer.ts';

/** A maximal run of half-width !/? of length exactly 2 (lookarounds reject longer runs). */
const PAIR = /(?<![!?])[!?]{2}(?![!?])/g;

/** Wraps every qualifying pair in `text` (one line-local segment), skipping `skipTail` at the
 *  very end (the pair a following ［＃「…」は縦中横］ postfix already covers). */
function rewriteSegment(text: string, skipTail: string | null): string {
  return text.replace(PAIR, (pair, index: number) =>
    skipTail === pair && index + pair.length === text.length
      ? pair
      : `${pair}［＃「${pair}」は縦中横］`,
  );
}

/** The source with every qualifying pair wrapped (see the module doc for the full contract). */
export function materializeAutoTcy(src: string): string {
  const tokens = tokenize(src);
  let out = '';
  let inSpan = false; // inside a manual ［＃縦中横］ … (終わり or line end)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    if (token.kind === 'tcySpanStart') {
      inSpan = true;
    } else if (token.kind === 'tcySpanEnd') {
      inSpan = false;
    } else if (token.kind === 'text') {
      // A pair at the very end of this token may already be covered by an immediately
      // following postfix — the exact shape this pass emits (idempotency).
      const next = tokens[i + 1];
      const skipTail = next?.kind === 'tcyPostfix' ? next.target : null;
      // The manual span is LINE-LOCAL: a line break inside the text closes it, so only the
      // first segment is exempt while the span is open; later segments scan normally.
      const parts = token.text.split('\n'); // not splitLines: the rejoin keeps a CRLF '\r'
      const rewritten = parts.map((part, pi) => {
        const exempt = inSpan && pi === 0;
        if (parts.length > 1 && pi === 0) {
          inSpan = false; // the first line break auto-closes an open span
        }
        const last = pi === parts.length - 1;
        return exempt ? part : rewriteSegment(part, last ? skipTail : null);
      });
      out += rewritten.join('\n');
      continue;
    }
    out += token.raw;
  }
  return out;
}

/** `materializeAutoTcy` gated by the settings enum — `none` returns the source untouched. */
export function applyAutoTcy(src: string, mode: AutoTcyMode): string {
  return mode === 'punctuationPairs' ? materializeAutoTcy(src) : src;
}
