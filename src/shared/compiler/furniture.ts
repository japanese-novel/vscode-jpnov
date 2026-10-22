/**
 * The page furniture of the paginated build: the header and the footer of a sheet, horizontal
 * lines outside the vertical engine. Pure + vscode-free.
 */
import type { Chars, Line, ValueFieldNode, ValueLookup } from '../ast/nodes.ts';
import { VALUE_NAMES, valueOf } from '../ast/notation.ts';
import { parse } from '../ast/parse.ts';
import { runsIn } from '../ast/span.ts';
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

/** A value to look up by name per page, under its function when it has one. */
interface ValueSlot {
  readonly name: string;
  readonly format: string | undefined;
}

/** A header or footer line cut into what it prints: a value slot, or text as shown. */
type FurnitureSlot = string | ValueSlot;

/** The name a value run shows, with its function: those of the ［＃ここに「…」の値を表示］
 *  written where the run is. */
function fieldOf(line: Line, run: Chars): ValueSlot {
  const field = line.syntax.find((node): node is ValueFieldNode => node.kind === 'valueField' && node.span.start === run.span.start);
  return { name: field?.name.text ?? '', format: field?.format?.text };
}

/**
 * The slots of a header or footer line, cut from the AST's content: a value run names its field
 * (looked up per page), wherever it sits; every other run prints its characters, a ruby's base
 * and a 縦中横's text among them, since the furniture is plain text; a comment prints nothing.
 */
function furnitureSlots(text: string): readonly FurnitureSlot[] {
  return parse(text).lines.flatMap((line): FurnitureSlot[] => [
    ...runsIn(line.content).map((run): FurnitureSlot => (run.origin === 'value' ? fieldOf(line, run) : run.text)),
    line.eol,
  ]);
}

function furnitureHtml(slots: readonly FurnitureSlot[], values: ValueLookup): string {
  return slots.map((slot) => escapeHtml(typeof slot === 'string' ? slot : valueOf(slot.name, values, slot.format))).join('');
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
 * page's number joins the book's `values` (総ページ数 included) under {@link VALUE_NAMES}. An empty
 * header or footer emits no element (renderBook folds a blank one to '').
 */
export function pageFurniture(
  chrome: BuildChrome,
  furniture: Furniture,
  values: ValueLookup | undefined,
  pi: number,
): string {
  const all: ValueLookup = { get: (name) => (name === VALUE_NAMES.page ? String(pi + 1) : values?.get(name)) };
  const band = (cls: 'hd' | 'ft', key: 'header' | 'footer', align: FurnitureAlign): string =>
    chrome[key] === '' ? '' : `<div class="${cls} ${furnitureSide(align, pi)}">${furnitureHtml(furniture[key], all)}</div>`;
  return band('hd', 'header', chrome.headerAlign) + band('ft', 'footer', chrome.footerAlign);
}
