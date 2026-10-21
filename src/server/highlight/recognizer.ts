/**
 * Narration recognizer: highlights the author's cast and coined keywords in plain body-text runs.
 *
 * Built from a root's cast surfaces (every form a listed name is recognised by: `nameSurfaces` in
 * `src/shared/book/names.ts`) and keywords — pure and synchronous, with no dictionary and no async
 * load. A character is highlighted ONLY where it reads as a SUBJECT: a name (a surname/given alone
 * is fine, optionally followed by ONE honorific) immediately followed by は or が. The particle marks
 * the subject and is coloured together with the name. Keywords match exactly and only where no
 * character matched, so a surface in BOTH lists reads as the character when it is a subject
 * (followed by は or が) and as a plain keyword otherwise. Neither is matched directly after a kanji:
 * a listed word inside a longer kanji word (山田 in 小山田, 王都 in 新王都) stays plain.
 *
 * Offsets returned are indices into the run text the caller passed; the caller maps them back to the
 * document and decides where (narration vs dialogue) a span may apply.
 */

import { isKanji } from '../../shared/chars.ts';

/**
 * The entries by their first UTF-16 unit, each bucket longest-first, so a greedy match prefers
 * 山田太郎 over 山田 and the text's own unit picks the few entries to try.
 */
type Index = ReadonlyMap<number, readonly string[]>;

function indexOf(entries: Iterable<string>): Index {
  const index = new Map<number, string[]>();
  for (const s of [...entries].sort((a, b) => b.length - a.length)) {
    const bucket = index.get(s.charCodeAt(0));
    if (bucket === undefined) {
      index.set(s.charCodeAt(0), [s]);
    } else {
      bucket.push(s);
    }
  }
  return index;
}

/** The longest entry of `index` that `text` starts with at `pos`, else ''. */
function matchAt(index: Index, text: string, pos: number): string {
  for (const s of index.get(text.charCodeAt(pos)) ?? []) {
    if (text.startsWith(s, pos)) {
      return s;
    }
  }
  return '';
}

/** Honorifics that may sit between a name and its subject particle; coloured together with the name. */
export const HONORIFICS = ['先生', 'ちゃん', 'さま', 'たん', 'さん', '様', '君', '殿'];
/** Subject-marking particles that must immediately follow a name(+honorific) for it to highlight. */
export const PARTICLES = ['は', 'が'];

/** Whether the code point ending just before `pos` is a kanji (a surrogate pair read whole). */
function afterKanji(text: string, pos: number): boolean {
  if (pos === 0) {
    return false;
  }
  const unit = text.charCodeAt(pos - 1);
  const at = unit >= 0xdc00 && unit <= 0xdfff && pos >= 2 ? pos - 2 : pos - 1;
  return isKanji(text.codePointAt(at) ?? 0);
}

export interface RecognizerSpan {
  /** Start index into the run text passed to {@link Recognizer.recognize} (UTF-16 units). */
  readonly start: number;
  readonly len: number;
  /** Highlight kind — a subset of the semantic-token kinds in semanticTokens.ts (no remap needed). */
  readonly kind: 'character' | 'keyword';
}

export interface Recognizer {
  recognize(runText: string): readonly RecognizerSpan[];
}

export function createRecognizer(
  surfaces: readonly string[],
  keywords: readonly string[],
): Recognizer {
  const subjects = indexOf(new Set(surfaces));
  const honorifics = indexOf(HONORIFICS);
  const particles = indexOf(PARTICLES);
  const keys = indexOf(new Set(keywords));

  return {
    recognize(runText: string): readonly RecognizerSpan[] {
      const out: RecognizerSpan[] = [];
      const n = runText.length;
      let i = 0;
      while (i < n) {
        if (afterKanji(runText, i)) {
          i += 1; // inside a longer kanji word: neither a name nor a keyword starts here
          continue;
        }
        // Character-as-subject: name (+ one honorific) immediately followed by は / が.
        const name = matchAt(subjects, runText, i);
        if (name !== '') {
          const afterHonorific = i + name.length + matchAt(honorifics, runText, i + name.length).length;
          const particle = matchAt(particles, runText, afterHonorific);
          if (particle !== '') {
            out.push({ start: i, len: afterHonorific - i + particle.length, kind: 'character' }); // name + honorific + particle
            i = afterHonorific + particle.length;
            continue;
          }
        }
        // Keyword: exact match, only where no character subject matched (character wins on overlap).
        const key = matchAt(keys, runText, i);
        if (key !== '') {
          out.push({ start: i, len: key.length, kind: 'keyword' });
          i += key.length;
          continue;
        }
        i += 1;
      }
      return out;
    },
  };
}
