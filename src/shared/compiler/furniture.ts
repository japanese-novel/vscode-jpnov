/**
 * The page furniture of the paginated build: the header and the footer of a sheet, horizontal
 * lines outside the vertical engine. Pure + vscode-free.
 */
import type { ValueLookup } from '../ast/nodes.ts';
import { VALUE_NAMES, valueOf } from '../ast/notation.ts';
import { scan } from '../ast/scan.ts';
import type { BuildChrome, FurnitureAlign } from './chrome.ts';
import { escapeHtml } from '../utils/escape.ts';

/** The side class (`r` / `l` / `c`) of a header or footer on page `pi` (0-based). */
function furnitureSide(align: FurnitureAlign, pi: number): 'r' | 'l' | 'c' {
  const odd = pi % 2 === 0; // display page = pi + 1, so an even index is an odd page
  switch (align) {
    case 'rightLeft':
      return odd ? 'r' : 'l';
    case 'leftRight':
      return odd ? 'l' : 'r';
    case 'right':
      return 'r';
    case 'left':
      return 'l';
    case 'center':
      return 'c';
  }
}

/** A header or footer line cut into what it prints: a value to look up by name, or text as typed. */
type FurnitureSlot = string | { readonly name: string };

/**
 * The slots of a header or footer line. Only ［＃ここに「…」の値を表示］ is interpreted; every
 * other node — prose, ruby, any other annotation — prints as its source characters.
 */
function furnitureSlots(text: string): readonly FurnitureSlot[] {
  return scan(text).lines.flatMap((line): FurnitureSlot[] => [
    ...line.syntax.map((node) => (node.kind === 'valueField' ? { name: node.name.text } : node.text)),
    line.eol,
  ]);
}

function furnitureHtml(slots: readonly FurnitureSlot[], values: ValueLookup): string {
  return slots.map((slot) => escapeHtml(typeof slot === 'string' ? slot : valueOf(slot.name, values))).join('');
}

/** The header and footer of one render, cut once for all its pages. */
export interface Furniture {
  readonly header: readonly FurnitureSlot[];
  readonly footer: readonly FurnitureSlot[];
}

export function cutFurniture(chrome: BuildChrome): Furniture {
  return { header: furnitureSlots(chrome.header), footer: furnitureSlots(chrome.footer) };
}

/**
 * One page's absolutely-positioned furniture (header + footer), emitted after its lines. The
 * page's own numbers join the book's `values` under {@link VALUE_NAMES}. An empty header or footer
 * emits no element (renderBook folds a blank one to '').
 */
export function pageFurniture(
  chrome: BuildChrome,
  furniture: Furniture,
  values: ValueLookup | undefined,
  pi: number,
  totalPage: number,
): string {
  const own = new Map<string, string>([
    [VALUE_NAMES.page, String(pi + 1)],
    [VALUE_NAMES.totalPages, String(totalPage)],
  ]);
  const all: ValueLookup = { get: (name) => own.get(name) ?? values?.get(name) };
  const band = (cls: 'hd' | 'ft', key: 'header' | 'footer', align: FurnitureAlign): string =>
    chrome[key] === '' ? '' : `<div class="${cls} ${furnitureSide(align, pi)}">${furnitureHtml(furniture[key], all)}</div>`;
  return band('hd', 'header', chrome.headerAlign) + band('ft', 'footer', chrome.footerAlign);
}
