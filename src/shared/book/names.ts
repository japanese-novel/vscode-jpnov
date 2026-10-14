/**
 * The items of a book's `characters:` and `keywords:` lists, read as one `.jpnov` line each:
 * text and ruby, nothing else. A name splits into parts at a space and at every ruby boundary,
 * so `山田　太郎`, `山田《やまだ》太郎《たろう》` and `山田｜太郎《たろう》` all read 山田 / 太郎, while
 * `｜山田太郎《やまだたろう》` and `山田太郎` stay one part. An implicit base is the run the Scanner
 * gives it in the body (the maximal run of one character class): `山田太郎《たろう》` is ONE part.
 * A keyword reads the same way; its parts are never used apart.
 *
 * Identity is the base text, readings and separators aside: two items with one identity are one
 * entry, and a different writing of it (a reading, a split) is the conflict the book diagnostics
 * report. Pure and vscode-free; reads the Scanner's nodes like `parseDividerValue`.
 */
import { ANNOTATION_CLOSE, ANNOTATION_OPEN, BASE_MARK, RUBY_CLOSE, RUBY_OPEN } from '../ast/notation.ts';
import { scan } from '../ast/scan.ts';
import { displayText } from '../chars.ts';

/** One part of a name: its base text and the reading written for it, if any. */
export interface NamePart {
  readonly base: string;
  readonly reading: string | null;
}

/** A list item as read: `text` is the base text as written (readings and ｜ stripped, spaces kept). */
export interface ListedName {
  readonly text: string;
  readonly parts: readonly NamePart[];
}

/** A valid item of a name list: its document line, the item as written, what it reads as, and its {@link nameIdentity}. */
export interface NameEntry {
  readonly line: number;
  readonly text: string;
  readonly name: ListedName;
  readonly identity: string;
}

export type ReadName =
  | { readonly ok: true; readonly name: ListedName }
  /** `empty`: nothing to read; `notPlain`: an annotation other than ruby, or a marker left as text. */
  | { readonly ok: false; readonly error: 'empty' | 'notPlain' };

/** A ruby or annotation marker left in the text: a ｜ with no reading, an unmatched 《, a lone ［ or ］. */
const LEFTOVER_MARKUP = new RegExp(`[${ANNOTATION_OPEN.charAt(0)}${ANNOTATION_CLOSE}${RUBY_OPEN}${RUBY_CLOSE}${BASE_MARK}]`);

/** Runs of the spaces a name splits on, half- or full-width. */
const SPACES = /[ 　]+/;

const NOT_PLAIN: ReadName = { ok: false, error: 'notPlain' };

/** Reads one item. Never throws. */
export function readName(text: string): ReadName {
  const { lines, issues } = scan(text);
  if (issues.length > 0) {
    return NOT_PLAIN; // a 《》 or a reading with no base: not a name as written
  }
  const parts: NamePart[] = [];
  let plain = '';
  // The text of an explicit base, collected from its ｜ until its reading.
  let held: string[] | null = null;
  // The text node an implicit reading binds to; the Scanner puts the reading right after it.
  let pending = '';
  for (const node of lines[0]?.syntax ?? []) {
    switch (node.kind) {
      case 'text':
        if (LEFTOVER_MARKUP.test(node.text)) {
          return NOT_PLAIN;
        }
        plain += node.text;
        if (held !== null) {
          held.push(node.text);
        } else if (node.rubyBase === true) {
          pending = node.text;
        } else {
          for (const chunk of node.text.split(SPACES)) {
            if (chunk !== '') {
              parts.push({ base: chunk, reading: null });
            }
          }
        }
        break;
      case 'rubyMark':
        held = [];
        break;
      case 'rubyReading':
        if (node.implicit) {
          parts.push({ base: pending, reading: node.reading.text });
          pending = '';
        } else {
          parts.push({ base: (held ?? []).join(''), reading: node.reading.text });
          held = null;
        }
        break;
      default:
        return NOT_PLAIN;
    }
  }
  if (parts.length === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, name: { text: plain, parts } };
}

/** The base text of a name, its parts joined: what the body is matched against. */
export function nameBase(name: ListedName): string {
  return name.parts.map((p) => p.base).join('');
}

/** Text as an output shows it, NFC: how bases compare. */
function norm(text: string): string {
  return displayText(text).normalize('NFC');
}

/** What makes two items one entry: the base text alone. */
export function nameIdentity(name: ListedName): string {
  return norm(nameBase(name));
}

/** True when `a` and `b` are written alike: the same parts with the same readings. */
export function sameWriting(a: ListedName, b: ListedName): boolean {
  return a.parts.length === b.parts.length &&
    a.parts.every((p, i) => {
      const q = b.parts[i];
      return q !== undefined && norm(p.base) === norm(q.base) && p.reading === q.reading;
    });
}

/**
 * The surfaces a character is recognised by: the text as written (a Western name keeps its
 * space), the parts joined (how a full Japanese name is typeset), and each part alone.
 */
export function nameSurfaces(name: ListedName): string[] {
  return [name.text, nameBase(name), ...name.parts.map((p) => p.base)];
}

/** Another book's list, labelled for the message. */
export interface LabelledNames {
  readonly label: string;
  readonly names: readonly NameEntry[];
}

/** One of my items written differently in another book. */
export interface NameConflict {
  readonly line: number;
  readonly base: string;
  readonly label: string;
}

/**
 * My items that another book lists with the same identity but another writing (a reading, a
 * split): one conflict per such book. The same writing in another book is no conflict — the
 * volumes of a series repeat their cast freely.
 */
export function nameConflicts(mine: readonly NameEntry[], others: readonly LabelledNames[]): NameConflict[] {
  const out: NameConflict[] = [];
  for (const other of others) {
    const byIdentity = new Map(other.names.map((o) => [o.identity, o.name]));
    for (const entry of mine) {
      const twin = byIdentity.get(entry.identity);
      if (twin !== undefined && !sameWriting(entry.name, twin)) {
        out.push({ line: entry.line, base: nameBase(entry.name), label: other.label });
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
