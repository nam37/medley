// Draws a snapshot's lines: word-wrapped to the view, only the visible rows,
// with refs highlighted, a gutter mark on lines that just changed, find
// matches, and a selected ref. Clicking a ref activates it.
//
// Grid modes change only where lines are drawn, never the lines:
//  - partial: the outermost blocks that sat side by side on the page become
//    columns (when every column gets a readable width);
//  - advanced: the page itself, scaled to the terminal. Each line's text goes
//    where its box was, over the page's backgrounds and card borders, with
//    pictures drawn from a screenshot in half-block characters.

import {
  RGBA,
  Renderable,
  TextAttributes,
  type MouseEvent,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from '@opentui/core';
import type { LayoutGroup, Rect, Visual } from '../render.ts';
import { findTokens, type Token } from '../tokens.ts';
import { THEME } from './theme.ts';

const GUTTER = 2; // change marker + space
const SEP = 3; // " │ " between columns
const MIN_COLUMN = 20; // narrowest column worth drawing
const EMBED = /\[(?:img|iframe|video|audio|canvas|embed)(?: "(?:[^"\\]|\\.)*")?\]/g;

export type GridMode = 'none' | 'partial' | 'advanced';
export const GRID_MODES: GridMode[] = ['none', 'partial', 'advanced'];
export const GRID_LABELS: Record<GridMode, string> = {
  none: 'no grid',
  partial: 'partial grid',
  advanced: 'advanced grid',
};

// Per-character styles are small integers indexing these.
const FG: RGBA[] = [THEME.text, THEME.dim, THEME.link, THEME.control, THEME.heading, THEME.landmark, THEME.code, THEME.findFg];
const [TEXT, DIM, LINK, CONTROL, HEADING, LANDMARK, CODE, FIND_FG] = FG.map((_, i) => i);
const BG: (RGBA | undefined)[] = [undefined, THEME.findBg, THEME.findCurrentBg];
const [NO_BG, FIND_BG, CURRENT_BG] = BG.map((_, i) => i);
const PLACEHOLDER = RGBA.fromHex('#d5d9df'); // a picture not loaded yet
// Pictures are drawn smaller than the space they had, centered in it, so they
// don't crowd the text. Backgrounds keep their full size.
const PICTURE_SCALE = 0.7;
// Behind text laid over a picture, so it stays readable.
const DARK_BACKDROP = RGBA.fromHex('#1f1f1f');
const LIGHT_BACKDROP = RGBA.fromHex('#f3f3f3');
const backdropFor = (fg: RGBA) => {
  const [r, g, b] = fg.toInts();
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 128 ? DARK_BACKDROP : LIGHT_BACKDROP;
};
// On the page canvas the text format's own markup (# before headings, ── dividers) is left out.
const HEADING_MARK = /^#{1,6} /;
const isDivider = (line: string) => line.startsWith('── ');
const TABLE_RULE = RGBA.fromHex('#9aa0a8'); // a table's grid lines on the page canvas
const TABLE_SEPARATOR = /^\|[-|]+\|$/; // the |---|---| under a header row

/**
 * The cells of a table row in the text format, `| a | b |`, as ranges of the
 * line without their padding, or null if the line isn't a row. Cell text
 * escapes its own pipes as \|.
 */
function parseRow(line: string): { start: number; end: number }[] | null {
  if (line.length < 4 || !line.startsWith('| ') || !line.endsWith(' |')) return null;
  const cells: { start: number; end: number }[] = [];
  const last = line.length - 2; // where the closing " |" starts
  let start = 2;
  for (let i = 2; i <= last; i++) {
    if (i !== last && !(line.startsWith(' | ', i) && line[i - 1] !== '\\')) continue;
    let s = start;
    let e = i;
    while (s < e && line[s] === ' ') s++;
    while (e > s && line[e - 1] === ' ') e--;
    cells.push({ start: s, end: e });
    start = i + 3;
    i += 2;
  }
  return cells;
}

/** A ref as it appears on a line. For links, `textEnd` also covers the link text. */
export interface PageRef extends Token {
  line: number;
  textEnd: number;
}

/** A screenshot's pixels: RGBA rows, `scale` pixels per page pixel. */
export interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
  stride: number;
  scale: number;
}

/** Part of a line drawn at column `x` of the view (after the gutter). */
interface Piece {
  line: number;
  start: number;
  end: number;
  x: number;
  bold?: boolean; // a table's header row or caption
}

/** One screen row: pieces side by side, and the column separators between them. */
interface Row {
  pieces: Piece[];
  seps: number[];
}

/** Something drawn in a block of cells on the page canvas. */
interface Area {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

interface Match {
  line: number;
  start: number;
  end: number;
}

export interface PageViewOptions extends RenderableOptions<PageView> {
  onActivate?: (ref: PageRef) => void;
  onScroll?: () => void;
}

/** Split a line into rows of at most `width` cells, breaking after spaces where possible. */
export function wrap(line: string, width: number): { start: number; end: number; indent: number }[] {
  if (width <= 0 || Bun.stringWidth(line) <= width) return [{ start: 0, end: line.length, indent: 0 }];
  // Continuation rows line up under the text of a list item or quote.
  const hang = Math.min(Bun.stringWidth(/^\s*(?:(?:[-*>]|\d+\.)\s+)?/.exec(line)![0]), Math.floor(width / 2));
  const rows: { start: number; end: number; indent: number }[] = [];
  let start = 0;
  let indent = 0;
  while (start < line.length) {
    const avail = width - indent;
    let used = 0;
    let i = start;
    let lastBreak = -1;
    while (i < line.length) {
      const ch = String.fromCodePoint(line.codePointAt(i)!);
      const w = Bun.stringWidth(ch);
      if (used + w > avail) break;
      used += w;
      i += ch.length;
      if (ch === ' ') lastBreak = i;
    }
    if (i >= line.length) {
      rows.push({ start, end: line.length, indent });
      break;
    }
    const end = lastBreak > start ? lastBreak : Math.max(i, start + 1);
    rows.push({ start, end, indent });
    start = end;
    indent = hang;
  }
  return rows;
}

/** The index in `line` under a column of [start, end), or -1 past its end. */
function offsetAt(line: string, start: number, end: number, column: number): number {
  if (column < 0) return -1;
  let used = 0;
  for (let i = start; i < end; ) {
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    used += Bun.stringWidth(ch);
    if (used > column) return i;
    i += ch.length;
  }
  return -1;
}

const groupEnd = (g: LayoutGroup) => g.cells[g.cells.length - 1].end;
const isBlank = (row: Row) => row.pieces.every((p) => p.start === p.end);

function union(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined;
  const x0 = Math.min(...rects.map((r) => r[0]));
  const y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2]));
  const y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

const colors = new Map<string, RGBA>();
function color(hex: string): RGBA {
  let c = colors.get(hex);
  if (!c) colors.set(hex, (c = RGBA.fromHex(hex)));
  return c;
}

export class PageView extends Renderable {
  private lines: string[] = [];
  private refsByLine: PageRef[][] = [];
  private refs: PageRef[] = []; // first appearance of each ref, in reading order
  private fenced: boolean[] = [];
  private changed = new Set<number>();
  private groups = new Map<string, LayoutGroup>(); // by `${depth}:${first line}`
  private visual: Visual | null = null;
  private pixels: Pixels | null = null;
  private mode: GridMode = 'none';
  private rows: Row[] = [];
  private rowOfLine = new Int32Array(0); // first row showing each line, or -1
  private layoutKey = '';
  private columnGroups = 0; // groups drawn as columns in the current layout
  private canvas = false; // the current layout is the page canvas
  private decor: (Area & { bg?: RGBA; bd?: RGBA })[] = [];
  private pictures: (Area & { image: number; cells?: RGBA[] })[] = [];
  private rules: { row: number; col: number; text: string }[] = []; // tables' grid lines
  private topRow = 0;
  private anchorLine = 0; // the line at the top of the view, kept across re-layout
  private selected: number | null = null;
  private matches: Match[] = [];
  private currentMatch = -1;
  private onActivate?: (ref: PageRef) => void;
  private onScroll?: () => void;

  constructor(ctx: RenderContext, { onActivate, onScroll, ...options }: PageViewOptions) {
    super(ctx, options);
    this.onActivate = onActivate;
    this.onScroll = onScroll;
  }

  /**
   * Show new page lines. `fresh` means a different document: start at the top
   * with nothing selected. Otherwise keep the position and selection.
   */
  setPage(
    lines: string[],
    labels: Map<number, string>,
    changed: Set<number>,
    fresh: boolean,
    layout: LayoutGroup[] = [],
    visual: Visual | null = null,
  ) {
    this.lines = lines;
    this.changed = changed;
    this.groups = new Map(layout.map((g) => [`${g.depth}:${g.cells[0].start}`, g]));
    this.visual = visual;
    if (fresh) this.pixels = null;
    let inFence = false;
    this.fenced = lines.map((l) => {
      if (l.startsWith('```')) {
        inFence = !inFence;
        return true;
      }
      return inFence;
    });
    this.refsByLine = lines.map((line, i) =>
      this.fenced[i] ? [] : findTokens(line).map((t) => ({ ...t, line: i, textEnd: linkTextEnd(line, t, labels) })),
    );
    const seen = new Set<number>();
    this.refs = this.refsByLine.flat().filter((r) => !seen.has(r.ref) && seen.add(r.ref));
    if (fresh) {
      this.anchorLine = 0;
      this.selected = null;
    } else if (this.selected !== null && !seen.has(this.selected)) {
      this.selected = null;
    }
    this.anchorLine = Math.min(this.anchorLine, Math.max(0, lines.length - 1));
    this.matches = [];
    this.currentMatch = -1;
    this.layoutKey = ''; // lay out again on next use
    this.requestRender();
  }

  /** The page screenshot's pixels, for drawing pictures in advanced grid. */
  setPixels(pixels: Pixels | null) {
    this.pixels = pixels;
    for (const p of this.pictures) p.cells = undefined;
    this.requestRender();
  }

  get refCount(): number {
    return this.refs.length;
  }

  hasRef(ref: number): PageRef | undefined {
    return this.refs.find((r) => r.ref === ref);
  }

  // ---- grid modes -------------------------------------------------------------

  get gridMode(): GridMode {
    return this.mode;
  }

  set gridMode(mode: GridMode) {
    this.mode = mode;
    this.layoutKey = '';
    this.requestRender();
  }

  /** How many side-by-side groups are drawn as columns right now. */
  get columnCount(): number {
    this.layout();
    return this.columnGroups;
  }

  /** Whether the page is drawn as its own layout (advanced grid with layout data). */
  get drawsPage(): boolean {
    this.layout();
    return this.canvas;
  }

  // ---- layout -------------------------------------------------------------

  private layout() {
    const width = this.width - GUTTER;
    const key = `${width}:${this.mode}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.columnGroups = 0;
    this.canvas = this.mode === 'advanced' && !!this.visual && width > 0;
    this.decor = [];
    this.pictures = [];
    this.rules = [];
    this.rows = this.canvas ? this.pageLayout(width) : this.flow(0, this.lines.length, 0, width, 0);
    this.rowOfLine = new Int32Array(this.lines.length).fill(-1);
    this.rows.forEach((row, r) => {
      for (const p of row.pieces) if (this.rowOfLine[p.line] < 0) this.rowOfLine[p.line] = r;
    });
    this.topRow = this.firstRowOf(this.anchorLine);
    this.clamp();
  }

  /** Rows for lines [start, end), drawn from column `x` in `width` cells. */
  private flow(start: number, end: number, x: number, width: number, depth: number): Row[] {
    const rows: Row[] = [];
    for (let i = start; i < end; ) {
      const group = this.groupAt(depth, i);
      if (group && groupEnd(group) <= end) {
        // Too narrow for columns: lay it out linearly, still trying the groups nested inside.
        rows.push(...(this.columns(group, x, width) ?? this.flow(i, groupEnd(group), x, width, depth + 1)));
        i = groupEnd(group);
        continue;
      }
      for (const w of wrap(this.lines[i], width)) {
        rows.push({ pieces: [{ line: i, start: w.start, end: w.end, x: x + w.indent }], seps: [] });
      }
      i++;
    }
    return rows;
  }

  private groupAt(depth: number, line: number): LayoutGroup | undefined {
    if (this.mode === 'none' || (this.mode === 'partial' && depth > 0)) return undefined;
    return this.groups.get(`${depth}:${line}`);
  }

  /** A group's cells side by side, widths in proportion to the page, or null if they don't fit. */
  private columns(group: LayoutGroup, x: number, width: number): Row[] | null {
    const cells = group.cells.filter((c) => this.lines.slice(c.start, c.end).some((l) => l.trim()));
    if (cells.length < 2) return null;
    const avail = width - SEP * (cells.length - 1);
    const total = cells.reduce((n, c) => n + (c.w || 1), 0);
    const widths = cells.map((c) => Math.floor((avail * (c.w || 1)) / total));
    widths[widths.indexOf(Math.max(...widths))] += avail - widths.reduce((a, b) => a + b, 0);
    if (widths.some((w) => w < MIN_COLUMN)) return null;

    let cx = x;
    const seps: number[] = [];
    const columns = cells.map((c, k) => {
      const rows = this.flow(c.start, c.end, cx, widths[k], group.depth + 1);
      while (rows.length && isBlank(rows[0])) rows.shift();
      while (rows.length && isBlank(rows[rows.length - 1])) rows.pop();
      cx += widths[k] + SEP;
      if (k < cells.length - 1) seps.push(cx - 2);
      return rows;
    });
    this.columnGroups++;
    const height = Math.max(...columns.map((c) => c.length));
    return Array.from({ length: height }, (_, r) => ({
      pieces: columns.flatMap((c) => c[r]?.pieces ?? []),
      seps: [...seps, ...columns.flatMap((c) => c[r]?.seps ?? [])],
    }));
  }

  /**
   * The page canvas: text runs and pictures placed top to bottom where they
   * were on the page, scaled to `width` cells. A skyline keeps things from
   * overlapping, and when text needs more rows than its box had on the page,
   * everything below that box moves down by the same amount, so blocks that
   * lined up on the page still line up.
   */
  private pageLayout(width: number): Row[] {
    const v = this.visual!;
    const sx = width / Math.max(1, v.width);
    const sy = sx / 2; // terminal cells are about twice as tall as they are wide
    const pageRow = (y: number) => Math.round(y * sy);

    type Item = { r: Rect; order: number; lines: [number, number]; table: boolean };
    const items: Item[] = [];
    const boxOf = (i: number) => v.lines[i]?.[0];
    let last: Rect = [0, 0, v.width, 0];
    const skip = (i: number) => !this.lines[i].trim() || (!this.fenced[i] && isDivider(this.lines[i]));
    for (let i = 0; i < this.lines.length; ) {
      if (skip(i)) {
        i++;
        continue;
      }
      // A run of lines from one box; a blank line inside it stays with it.
      const key = boxOf(i);
      let j = i + 1;
      while (j < this.lines.length) {
        const same = this.lines[j].trim() ? boxOf(j) === key : !!this.lines[j + 1]?.trim() && boxOf(j + 1) === key;
        if (!same) break;
        j++;
      }
      const ids = new Set<number>();
      for (let k = i; k < j; k++) for (const id of v.lines[k] ?? []) ids.add(id);
      let r = union([...ids].map((id) => v.boxes[id].r)) ?? [0, last[1] + last[3], v.width, 20];
      // A container's own text that follows its children belongs after them, not at its top.
      const inside = r[0] <= last[0] && r[1] <= last[1] && r[0] + r[2] >= last[0] + last[2] && r[1] + r[3] >= last[1] + last[3];
      if (inside && r[1] < last[1]) r = [r[0], last[1], r[2], Math.max(0, r[1] + r[3] - last[1])];
      // Off the page to the side (carousel slides, skip links) isn't drawn, as on the page itself.
      if (r[0] < v.width && r[0] + r[2] > 0) {
        items.push({ r, order: items.length, lines: [i, j], table: !!v.boxes[key]?.table });
      }
      last = r;
      i = j;
    }
    items.sort((a, b) => a.r[1] - b.r[1] || a.order - b.order);

    const rows: Row[] = [];
    const placed: { r: Rect; top: number; bottom: number }[] = []; // where each run of text went
    const tables: (Area & { r: Rect })[] = []; // where each table's grid went
    const skyline = new Int32Array(width);
    const shifts: { bottom: number; shift: number }[] = [];
    const shiftAt = (y: number) => shifts.reduce((s, d) => (d.bottom <= y + 1 && d.shift > s ? d.shift : s), 0);
    for (const it of items) {
      const longest = Math.max(...this.lines.slice(it.lines[0], it.lines[1]).map((l) => Bun.stringWidth(l)));
      // A sliver of a box still gets a few words.
      const cols = Math.min(width, Math.max(1, Math.round(it.r[2] * sx), Math.min(12, longest)));
      const col = Math.min(Math.max(0, Math.round(it.r[0] * sx)), width - cols);
      let top = Math.max(0, pageRow(it.r[1]) + shiftAt(it.r[1]));
      for (let c = col; c < col + cols; c++) top = Math.max(top, skyline[c]);
      let r = top;
      let used = cols;
      let grid = null;
      if (it.table) {
        // A grid may grow wider than its box, but only into free space: not past
        // whatever sits beside it on the page (an infobox next to a side panel).
        let limit = width;
        for (const o of items) {
          const beside = o.r[1] < it.r[1] + it.r[3] && o.r[1] + o.r[3] > it.r[1] && o.r[0] >= it.r[0] + it.r[2] - 1;
          if (o !== it && beside) limit = Math.min(limit, Math.round(o.r[0] * sx) - 1);
        }
        grid = this.placeTable(it.lines, col, cols, Math.max(cols, limit - col), top, rows);
      }
      if (grid) {
        r = grid.bottom;
        used = grid.width;
        tables.push({ r: it.r, row: top, col, rows: r - top, cols: used });
      } else {
        for (let li = it.lines[0]; li < it.lines[1]; li++) {
          if (this.lines[li].trim() && skip(li)) continue;
          const from = this.fenced[li] ? 0 : (HEADING_MARK.exec(this.lines[li])?.[0].length ?? 0);
          for (const w of wrap(this.lines[li].slice(from), cols)) {
            const piece = { line: li, start: from + w.start, end: from + w.end, x: col + w.indent };
            (rows[r] ??= { pieces: [], seps: [] }).pieces.push(piece);
            r++;
          }
        }
      }
      for (let c = col; c < col + used; c++) skyline[c] = r;
      placed.push({ r: it.r, top, bottom: r });
      const overflow = r - pageRow(it.r[1] + it.r[3]);
      if (overflow > shiftAt(it.r[1] + it.r[3])) shifts.push({ bottom: it.r[1] + it.r[3], shift: overflow });
    }

    // Pictures, backgrounds and borders sit under the text, following the same
    // shifts; text laid over a picture on the page stays over it here.
    const mapRow = (y: number) => Math.max(0, pageRow(y) + shiftAt(y));
    // Unlike text, these are clipped at the edges rather than moved inside: a
    // carousel's next slide peeks in at the right, as it does on the page.
    const inTable = (r: Rect) => {
      const cx = r[0] + r[2] / 2;
      const cy = r[1] + r[3] / 2;
      return tables.some((t) => cx >= t.r[0] && cx <= t.r[0] + t.r[2] && cy >= t.r[1] && cy <= t.r[1] + t.r[3]);
    };
    v.images.forEach((im, image) => {
      // A grid's rows don't follow the page's, so a picture in a table would land on the wrong row.
      if (inTable(im.r)) return;
      const fullCol = Math.round(im.r[0] * sx);
      const fullCols = Math.max(1, Math.round(im.r[2] * sx));
      const fullRows = Math.max(1, pageRow(im.r[3]));
      if (fullCol >= width || fullCol + fullCols <= 0) return;
      // A background: nearly page-wide, or with sizable pictures lying on it (not
      // just a small floating icon that happens to overlap).
      const area = im.r[2] * im.r[3];
      const background =
        im.r[2] >= 0.8 * v.width ||
        v.images.some((o, i) => {
          if (i === image || o.r[2] * o.r[3] >= area || o.r[2] * o.r[3] < 0.03 * area) return false;
          const cx = o.r[0] + o.r[2] / 2;
          const cy = o.r[1] + o.r[3] / 2;
          return cx >= im.r[0] && cx <= im.r[0] + im.r[2] && cy >= im.r[1] && cy <= im.r[1] + im.r[3];
        });
      const scale = background ? 1 : PICTURE_SCALE;
      const cols = Math.max(1, Math.round(fullCols * scale));
      const rowsHigh = Math.max(1, Math.round(fullRows * scale));
      const col = fullCol + Math.floor((fullCols - cols) / 2);
      const row = mapRow(im.r[1]) + Math.floor((fullRows - rowsHigh) / 2);
      this.pictures.push({ row, col, rows: rowsHigh, cols, image });
    });
    for (const d of v.decor) {
      // A table's own background covers its grid, which draws its own lines.
      const table = tables.find((t) => t.r.every((n, i) => n === d.r[i]));
      if (table) {
        if (d.bg) this.decor.push({ row: table.row, col: table.col, rows: table.rows, cols: table.cols, bg: color(d.bg) });
        continue;
      }
      const left = Math.round(d.r[0] * sx);
      const right = Math.round((d.r[0] + d.r[2]) * sx);
      const col = Math.max(0, left);
      const cols = Math.min(width, right) - col;
      if (cols < 1) continue;
      // Span the text drawn inside the box, or its own height when it holds none; the
      // page-wide shift alone would stretch it by whatever overflowed beside it.
      const within = placed.filter(
        (p) => p.r[0] >= d.r[0] - 1 && p.r[1] >= d.r[1] - 1 && p.r[0] + p.r[2] <= d.r[0] + d.r[2] + 1 && p.r[1] + p.r[3] <= d.r[1] + d.r[3] + 1,
      );
      const row = Math.min(mapRow(d.r[1]), ...within.map((p) => p.top));
      const end = Math.max(row + pageRow(d.r[3]), ...within.map((p) => p.bottom + 1));
      const rowsHigh = Math.max(1, end - row);
      const clipped = left < 0 || right > width;
      const bd = d.bd && !clipped ? color(d.bd) : undefined; // a border cut off at the edge would mislead
      this.decor.push({ row, col, rows: rowsHigh, cols, bg: d.bg ? color(d.bg) : undefined, bd });
    }
    this.decor.sort((a, b) => b.rows * b.cols - a.rows * a.cols);

    const height = Math.max(rows.length, ...this.pictures.map((p) => p.row + p.rows), 0);
    for (let r = 0; r < height; r++) rows[r] ??= { pieces: [], seps: [] };
    return rows;
  }

  /**
   * A table's rows as a ruled grid from column `col`, starting at row `top`.
   * It takes its box's `cols` cells, or more (up to `maxCols`) when its text
   * needs them: monospaced text is wider than the page's own at this scale.
   * Columns get their natural width, or share the room and wrap when that
   * doesn't fit. A row with fewer cells than the table (an infobox's title)
   * has its last cell span the rest. Returns where the grid ended and how
   * wide it came out, or null when the lines aren't table rows (a one-column
   * table is plain lines).
   */
  private placeTable(lines: [number, number], col: number, boxCols: number, maxCols: number, top: number, rows: Row[]) {
    type Cell = { start: number; end: number };
    const parsed: { line: number; cells: Cell[]; header: boolean }[] = [];
    let caption: number | undefined;
    for (let li = lines[0]; li < lines[1]; li++) {
      const line = this.lines[li];
      if (TABLE_SEPARATOR.test(line)) {
        if (parsed.length) parsed[parsed.length - 1].header = true;
        continue;
      }
      const cells = parseRow(line);
      if (cells) parsed.push({ line: li, cells, header: false });
      else if (line.startsWith('Table: ')) caption = li;
    }
    if (!parsed.length) return null;

    const ncol = Math.max(...parsed.map((p) => p.cells.length));
    const sum = (a: number[]) => a.reduce((s, n) => s + n, 0);
    const text = (line: number, c: Cell) => this.lines[line].slice(c.start, c.end);
    // Natural widths, and the least that avoids breaking words, from cells that span one column.
    const most = new Array<number>(ncol).fill(1);
    const least = new Array<number>(ncol).fill(1);
    for (const p of parsed) {
      p.cells.forEach((c, k) => {
        if (k === p.cells.length - 1 && p.cells.length < ncol) return;
        const t = text(p.line, c);
        most[k] = Math.max(most[k], Bun.stringWidth(t));
        least[k] = Math.max(least[k], Math.min(16, ...t.split(/\s+/).map((w) => Bun.stringWidth(w))));
      });
    }
    const natural = sum(most) + 3 * ncol + 1; // each column also takes 2 padding and 1 rule
    const cols = Math.max(boxCols, Math.min(natural, maxCols));
    const room = Math.max(ncol, cols - 3 * ncol - 1);
    let widths = most;
    if (sum(most) > room) {
      widths =
        sum(least) <= room
          ? least.map((w, k) => w + Math.floor(((room - sum(least)) * (most[k] - w)) / Math.max(1, sum(most) - sum(least))))
          : least.map((w) => Math.max(1, Math.floor((w * room) / sum(least))));
    }
    const offsets = widths.map((_, k) => sum(widths.slice(0, k).map((w) => w + 3))); // each column's left rule
    const total = sum(widths.map((w) => w + 3)) + 1;

    // A horizontal rule, with junctions where the rows above and below have cell edges.
    const edges = (p?: (typeof parsed)[number]) => new Set(p ? Array.from({ length: p.cells.length - 1 }, (_, k) => k) : []);
    const horizontal = (above: Set<number>, below: Set<number>, left: string, right: string) => {
      let s = left;
      widths.forEach((w, k) => {
        s += '─'.repeat(w + 2);
        if (k === ncol - 1) return;
        const up = above.has(k);
        const down = below.has(k);
        s += up && down ? '┼' : up ? '┴' : down ? '┬' : '─';
      });
      return s + right;
    };

    let r = top;
    if (caption !== undefined) {
      const from = 'Table: '.length;
      for (const w of wrap(this.lines[caption].slice(from), total)) {
        (rows[r] ??= { pieces: [], seps: [] }).pieces.push({ line: caption, start: from + w.start, end: from + w.end, x: col + w.indent, bold: true });
        r++;
      }
    }
    this.rules.push({ row: r++, col, text: horizontal(new Set(), edges(parsed[0]), '┌', '┐') });
    parsed.forEach((p, i) => {
      const spans = p.cells.map((_, k) => {
        const end = k === p.cells.length - 1 ? ncol - 1 : k;
        return { x: col + offsets[k] + 2, w: sum(widths.slice(k, end + 1)) + 3 * (end - k) };
      });
      const wrapped = p.cells.map((c, k) => wrap(text(p.line, c), spans[k].w));
      const height = Math.max(1, ...wrapped.map((w) => w.length));
      for (let k = 0; k < height; k++) {
        const row = (rows[r] ??= { pieces: [], seps: [] });
        p.cells.forEach((c, j) => {
          const part = wrapped[j][k];
          if (!part || part.end <= part.start) return;
          row.pieces.push({ line: p.line, start: c.start + part.start, end: c.start + part.end, x: spans[j].x + part.indent, bold: p.header });
        });
        this.rules.push({ row: r, col, text: '│' });
        for (const s of spans) this.rules.push({ row: r, col: s.x + s.w + 1, text: '│' });
        r++;
      }
      const next = parsed[i + 1];
      const [left, right] = next ? ['├', '┤'] : ['└', '┘'];
      this.rules.push({ row: r++, col, text: horizontal(edges(p), edges(next), left, right) });
    });
    return { bottom: r, width: Math.min(total, cols) };
  }

  private firstRowOf(line: number): number {
    for (let l = line; l < this.lines.length; l++) if (this.rowOfLine[l] >= 0) return this.rowOfLine[l];
    return Math.max(0, this.rows.length - 1);
  }

  /** The row showing `offset` of `line` (a wrapped line spans consecutive rows). */
  private rowAt(line: number, offset: number): number {
    const first = this.firstRowOf(line);
    let best = first;
    for (let r = first; r < this.rows.length; r++) {
      const piece = this.rows[r].pieces.find((p) => p.line === line);
      if (!piece || piece.start > offset) break;
      best = r;
    }
    return best;
  }

  /** The first line shown on a row (or the last, looking upwards); rows can be empty on the canvas. */
  private lineAt(row: number, last = false): number {
    for (let r = row; r >= 0 && r < this.rows.length; r += last ? -1 : 1) {
      const lines = this.rows[r].pieces.map((p) => p.line);
      if (lines.length) return last ? Math.max(...lines) : Math.min(...lines);
    }
    return 0;
  }

  private get visibleRows(): number {
    return Math.max(1, this.height);
  }

  private clamp() {
    this.topRow = Math.max(0, Math.min(this.topRow, this.rows.length - this.visibleRows));
  }

  // ---- scrolling ------------------------------------------------------------

  scrollBy(rows: number) {
    this.layout();
    this.topRow += rows;
    this.clamp();
    this.anchorLine = this.lineAt(this.topRow);
    this.requestRender();
    this.onScroll?.();
  }

  pageBy(pages: number) {
    this.scrollBy(pages * Math.max(1, this.visibleRows - 2));
  }

  scrollToEnd(end: 'top' | 'bottom') {
    this.scrollBy(end === 'top' ? -this.rows.length - 1 : this.rows.length + 1);
  }

  get atBottom(): boolean {
    this.layout();
    return this.topRow + this.visibleRows >= this.rows.length;
  }

  /** How far down the view is, as "all", "top", "bottom" or a percentage. */
  get position(): string {
    this.layout();
    if (this.rows.length <= this.visibleRows) return 'all';
    if (this.topRow === 0) return 'top';
    if (this.atBottom) return 'bottom';
    return `${Math.round((100 * (this.topRow + this.visibleRows)) / this.rows.length)}%`;
  }

  /** Scroll so that a row is comfortably in view. */
  private reveal(row: number) {
    if (row >= this.topRow && row < this.topRow + this.visibleRows) return;
    this.topRow = row - Math.floor(this.visibleRows / 3);
    this.clamp();
    this.anchorLine = this.lineAt(this.topRow);
    this.onScroll?.();
  }

  // ---- refs -----------------------------------------------------------------

  get selectedRef(): PageRef | undefined {
    return this.selected === null ? undefined : this.hasRef(this.selected);
  }

  select(ref: number | null) {
    this.layout();
    this.selected = ref;
    const r = ref === null ? undefined : this.hasRef(ref);
    if (r) this.reveal(this.rowAt(r.line, r.start));
    this.requestRender();
  }

  /** Move the selection to the next (or previous) ref, starting from the view if nothing is selected. */
  selectNext(dir: 1 | -1): PageRef | undefined {
    this.layout();
    // Refs the page canvas leaves out (off the page to the side) can't be shown, so skip them.
    const refs = this.canvas ? this.refs.filter((r) => this.rowOfLine[r.line] >= 0) : this.refs;
    if (!refs.length) return undefined;
    let i = refs.findIndex((r) => r.ref === this.selected);
    if (i >= 0) {
      i = (i + dir + refs.length) % refs.length;
    } else {
      const top = this.lineAt(this.topRow);
      const bottom = this.lineAt(Math.min(this.topRow + this.visibleRows, this.rows.length) - 1, true);
      i = dir > 0 ? refs.findIndex((r) => r.line >= top) : refs.findLastIndex((r) => r.line <= bottom);
      if (i < 0) i = dir > 0 ? 0 : refs.length - 1;
    }
    this.select(refs[i].ref);
    return refs[i];
  }

  // ---- find -----------------------------------------------------------------

  /** Highlight every match of `query` (case-insensitive) and return how many there are. */
  setQuery(query: string): number {
    const q = query.toLowerCase();
    this.matches = [];
    this.currentMatch = -1;
    if (q) {
      this.lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
          this.matches.push({ line: i, start: at, end: at + q.length });
        }
      });
    }
    this.requestRender();
    return this.matches.length;
  }

  /** Go to the next (or previous) match; returns its 1-based number, or 0 if there are none. */
  nextMatch(dir: 1 | -1): number {
    this.layout();
    if (!this.matches.length) return 0;
    if (this.currentMatch < 0) {
      const top = this.lineAt(this.topRow);
      const i = this.matches.findIndex((m) => m.line >= top);
      this.currentMatch = i >= 0 ? i : 0;
    } else {
      this.currentMatch = (this.currentMatch + dir + this.matches.length) % this.matches.length;
    }
    const m = this.matches[this.currentMatch];
    this.reveal(this.rowAt(m.line, m.start));
    this.requestRender();
    return this.currentMatch + 1;
  }

  get matchCount(): number {
    return this.matches.length;
  }

  // ---- drawing ----------------------------------------------------------------

  private styleLine(li: number) {
    const line = this.lines[li];
    const fg = new Uint8Array(line.length).fill(TEXT);
    const bg = new Uint8Array(line.length).fill(NO_BG);
    const attrs = new Uint16Array(line.length);
    const refAt = new Int32Array(line.length); // which ref each character belongs to, 0 for none, -1 in an [img …] label
    if (this.fenced[li]) {
      fg.fill(line.startsWith('```') ? DIM : CODE);
    } else {
      if (/^#{1,6} /.test(line)) {
        fg.fill(HEADING);
        attrs.fill(TextAttributes.BOLD);
      } else if (line.startsWith('── ')) {
        fg.fill(LANDMARK);
      }
      for (const m of line.matchAll(EMBED)) {
        fg.fill(DIM, m.index, m.index + m[0].length);
        refAt.fill(-1, m.index, m.index + m[0].length);
      }
      for (const r of this.refsByLine[li]) {
        fg.fill(r.kind === 'link' ? LINK : CONTROL, r.start, r.end);
        refAt.fill(r.ref, r.start, Math.max(r.end, r.textEnd));
        for (let i = r.end; i < r.textEnd; i++) attrs[i] |= TextAttributes.UNDERLINE;
        if (r.ref === this.selected) {
          for (let i = r.start; i < Math.max(r.end, r.textEnd); i++) attrs[i] |= TextAttributes.INVERSE;
        }
      }
    }
    this.matches.forEach((m, i) => {
      if (m.line !== li) return;
      fg.fill(FIND_FG, m.start, m.end);
      bg.fill(i === this.currentMatch ? CURRENT_BG : FIND_BG, m.start, m.end);
    });
    return { fg, bg, attrs, refAt };
  }

  /** On the page canvas, text takes the page's own colors; refs keep theirs when the page set them. */
  private pageColors(li: number, style: number, ref: number): { fg: RGBA; bg?: RGBA; bold: boolean } {
    const v = this.visual!;
    const box = v.boxes[v.lines[li]?.[0]];
    const text = color(box?.fg ?? v.text);
    const own = ref ? v.refs[ref] : undefined;
    const bg = own?.bg ? color(own.bg) : undefined;
    if (style === LINK || style === CONTROL) return { fg: own?.fg ? color(own.fg) : FG[style], bg, bold: false };
    if (style === TEXT || style === HEADING) return { fg: ref && own?.fg ? color(own.fg) : text, bg, bold: !!box?.bold };
    return { fg: FG[style], bg, bold: false };
  }

  protected renderSelf(buffer: OptimizedBuffer) {
    this.layout();
    const x0 = this.screenX + GUTTER;
    const top = this.topRow;
    const bottom = top + this.visibleRows;
    if (this.canvas) this.drawCanvas(buffer, x0, top, bottom);

    const styles = new Map<number, ReturnType<PageView['styleLine']>>();
    for (let r = 0; r < this.visibleRows; r++) {
      const row = this.rows[top + r];
      if (!row) break;
      const y = this.screenY + r;
      if (row.pieces.some((p) => this.changed.has(p.line))) buffer.drawText('▎', this.screenX, y, THEME.changed);
      for (const sep of row.seps) buffer.drawText('│', x0 + sep, y, THEME.dim);
      for (const p of row.pieces) {
        let s = styles.get(p.line);
        if (!s) styles.set(p.line, (s = this.styleLine(p.line)));
        const line = this.lines[p.line];
        let x = x0 + p.x;
        for (let i = p.start; i < p.end; ) {
          let j = i + 1;
          while (j < p.end && s.fg[j] === s.fg[i] && s.bg[j] === s.bg[i] && s.attrs[j] === s.attrs[i] && s.refAt[j] === s.refAt[i]) j++;
          const text = line.slice(i, j);
          const cells = Bun.stringWidth(text);
          let fg = FG[s.fg[i]];
          let bg = BG[s.bg[i]];
          let attrs = s.attrs[i] | (p.bold ? TextAttributes.BOLD : 0);
          if (this.canvas && !bg) {
            // The picture itself is drawn, so its [img …] label would only cover it.
            if (s.refAt[i] === -1 && this.pixels) {
              x += cells;
              i = j;
              continue;
            }
            const page = this.pageColors(p.line, s.fg[i], Math.max(0, s.refAt[i]));
            fg = page.fg;
            bg = page.bg ?? (this.overPicture(top + r, x - x0, cells) ? backdropFor(fg) : undefined);
            if (page.bold) attrs |= TextAttributes.BOLD;
          }
          buffer.drawText(text, x, y, fg, bg, attrs);
          x += cells;
          i = j;
        }
      }
    }
  }

  /** Whether cells [col, col + cols) of a canvas row lie over a drawn picture. */
  private overPicture(row: number, col: number, cols: number): boolean {
    if (!this.pixels) return false;
    return this.pictures.some((p) => row >= p.row && row < p.row + p.rows && col < p.col + p.cols && col + cols > p.col);
  }

  /** The page's background, its boxes' backgrounds and borders, and its pictures. */
  private drawCanvas(buffer: OptimizedBuffer, x0: number, top: number, bottom: number) {
    const v = this.visual!;
    buffer.fillRect(this.screenX, this.screenY, this.width, this.height, color(v.canvas));
    const visible = (a: Area) => a.row < bottom && a.row + a.rows > top;
    const yOf = (row: number) => this.screenY + row - top;

    for (const d of this.decor) {
      if (!visible(d)) continue;
      const from = Math.max(d.row, top);
      const to = Math.min(d.row + d.rows, bottom);
      if (d.bg) buffer.fillRect(x0 + d.col, yOf(from), d.cols, to - from, d.bg);
      if (!d.bd || d.cols < 2 || d.rows < 2) continue;
      for (let row = from; row < to; row++) {
        const y = yOf(row);
        if (row === d.row || row === d.row + d.rows - 1) {
          const [l, r] = row === d.row ? ['┌', '┐'] : ['└', '┘'];
          buffer.drawText(l + '─'.repeat(d.cols - 2) + r, x0 + d.col, y, d.bd);
        } else {
          buffer.drawText('│', x0 + d.col, y, d.bd);
          buffer.drawText('│', x0 + d.col + d.cols - 1, y, d.bd);
        }
      }
    }

    for (const rule of this.rules) {
      if (rule.row >= top && rule.row < bottom) buffer.drawText(rule.text, x0 + rule.col, yOf(rule.row), TABLE_RULE);
    }

    const width = this.width - GUTTER;
    for (const p of this.pictures) {
      if (!visible(p)) continue;
      const cells = this.pixels ? (p.cells ??= this.sample(p)) : undefined;
      const from = Math.max(0, -p.col);
      const to = Math.min(p.cols, width - p.col); // clipped at the view's edges
      for (let row = Math.max(p.row, top); row < Math.min(p.row + p.rows, bottom); row++) {
        const y = yOf(row);
        if (!cells) {
          buffer.fillRect(x0 + p.col + from, y, to - from, 1, PLACEHOLDER);
          continue;
        }
        for (let c = from; c < to; c++) {
          const k = ((row - p.row) * p.cols + c) * 2;
          buffer.drawText('▀', x0 + p.col + c, y, cells[k], cells[k + 1]);
        }
      }
      if (!cells && p.row >= top && v.images[p.image].alt) {
        buffer.drawText(v.images[p.image].alt.slice(0, Math.max(0, p.cols - 2)), x0 + p.col + 1, yOf(p.row), THEME.dim, PLACEHOLDER);
      }
    }
  }

  /**
   * Average the screenshot over each half-cell of a picture: upper and lower
   * color per cell. Smaller pictures lying on this one (product shots on a
   * hero background) are drawn on their own, where their content ended up;
   * their pixels here would be a second copy, so those spots are filled with
   * the surrounding color instead.
   */
  private sample(p: Area & { image: number }): RGBA[] {
    const px = this.pixels!;
    const images = this.visual!.images;
    const r = images[p.image].r;
    const on = images
      .filter((o, i) => {
        if (i === p.image || o.r[2] * o.r[3] >= r[2] * r[3]) return false;
        const cx = o.r[0] + o.r[2] / 2;
        const cy = o.r[1] + o.r[3] / 2;
        return cx >= r[0] && cx <= r[0] + r[2] && cy >= r[1] && cy <= r[1] + r[3];
      })
      .map((o) => o.r);
    const covered = (x: number, y: number) => on.some((o) => x >= o[0] && x < o[0] + o[2] && y >= o[1] && y < o[1] + o[3]);

    // halves[h][c]: the color of half-row h, column c, or null where another picture lies.
    const halves = p.rows * 2;
    const grid: ([number, number, number] | null)[][] = [];
    for (let h = 0; h < halves; h++) {
      const line: ([number, number, number] | null)[] = [];
      const top = r[1] + (h * r[3]) / halves;
      const bottom = r[1] + ((h + 1) * r[3]) / halves;
      for (let c = 0; c < p.cols; c++) {
        const left = r[0] + (c * r[2]) / p.cols;
        const right = r[0] + ((c + 1) * r[2]) / p.cols;
        if (covered((left + right) / 2, (top + bottom) / 2)) {
          line.push(null);
          continue;
        }
        const x0 = Math.floor(left * px.scale);
        const x1 = Math.max(x0 + 1, Math.floor(right * px.scale));
        const y0 = Math.floor(top * px.scale);
        const y1 = Math.max(y0 + 1, Math.floor(bottom * px.scale));
        let red = 0;
        let green = 0;
        let blue = 0;
        let n = 0;
        // At most 4×4 samples per half-cell keeps big pictures cheap.
        const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
        const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
        for (let y = y0; y < y1; y += stepY) {
          if (y < 0 || y >= px.height) continue;
          for (let x = x0; x < x1; x += stepX) {
            if (x < 0 || x >= px.width) continue;
            const i = y * px.stride + x * 4;
            red += px.data[i];
            green += px.data[i + 1];
            blue += px.data[i + 2];
            n++;
          }
        }
        line.push(n ? [red / n, green / n, blue / n] : null);
      }
      grid.push(line);
    }

    // Fill each gap from the known color above it in its column (a background's
    // gradient carries on), or else below it. The color is taken a few
    // half-rows away from the gap, since right at its edge is the covering
    // picture's shadow, which would streak down the whole gap.
    const fill = (order: number[], c: number) => {
      const seen: [number, number, number][] = [];
      for (const h of order) {
        const k = grid[h][c];
        if (k) seen.push(k);
        else if (seen.length) grid[h][c] = seen[Math.max(0, seen.length - 3)];
      }
    };
    const down = Array.from({ length: halves }, (_, h) => h);
    for (let c = 0; c < p.cols; c++) {
      fill(down, c);
      fill([...down].reverse(), c);
    }
    const out: RGBA[] = [];
    for (let row = 0; row < p.rows; row++) {
      for (let c = 0; c < p.cols; c++) {
        for (const h of [row * 2, row * 2 + 1]) {
          const k = grid[h][c];
          out.push(k ? RGBA.fromInts(Math.round(k[0]), Math.round(k[1]), Math.round(k[2]), 255) : PLACEHOLDER);
        }
      }
    }
    return out;
  }

  protected onMouseEvent(e: MouseEvent) {
    if (e.type === 'scroll' && e.scroll) {
      if (e.scroll.direction === 'up' || e.scroll.direction === 'down') this.scrollBy(e.scroll.direction === 'up' ? -3 : 3);
      return;
    }
    if (e.type !== 'down' || e.button !== 0) return;
    const row = this.rows[this.topRow + (e.y - this.screenY)];
    const column = e.x - this.screenX - GUTTER;
    for (const p of row?.pieces ?? []) {
      const offset = offsetAt(this.lines[p.line], p.start, p.end, column - p.x);
      if (offset < 0) continue;
      const hit = this.refsByLine[p.line].find((r) => offset >= r.start && offset < Math.max(r.end, r.textEnd));
      if (!hit) return;
      this.selected = hit.ref;
      this.requestRender();
      this.onActivate?.(hit);
      return;
    }
  }
}

/** Where a link's text ends, from its label ("[7]Docs"); card-sized links may be cut short with …. */
function linkTextEnd(line: string, t: Token, labels: Map<number, string>): number {
  if (t.kind !== 'link') return t.end;
  const label = labels.get(t.ref)?.replace(/…$/, '');
  return label && line.startsWith(label, t.start) ? t.start + label.length : t.end;
}
