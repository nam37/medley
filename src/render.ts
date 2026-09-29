// Renders the page model from extract.js as text: markdown-ish blocks, numbered
// refs for interactive elements, landmark dividers, and a light touch of layout
// (blocks that sit side by side on the page share a line).
//
// Alongside the text it records, for clients that draw the page (the terminal
// UI), which blocks sat side by side and where each line's box was on the
// page. Neither ever changes the text itself.

export type Rect = [number, number, number, number];

export type Node = string | El;

export interface El {
  tag: string;
  d: 'b' | 'i';
  box?: 1; // inline-block: a separate visual chunk even without surrounding whitespace
  r?: Rect;
  c?: Node[];
  ref?: number;
  k?: string;
  n?: string;
  v?: string;
  s?: string[];
  href?: string;
  h?: number;
  lm?: string;
  lmn?: string;
  list?: 'ul' | 'ol';
  start?: number;
  li?: 1;
  bq?: 1;
  txt?: string;
  rows?: { th: 0 | 1; c: Node[] }[][];
  cap?: string;
  alt?: string;
  kind?: string;
  frame?: string; // a cross-origin iframe's frame id, until the session reads its content in (session.ts)
  ov?: string; // a dialog floating over the page (see Visual.layers)
  fg?: string; // text color, background, border (a card), bold: how it looks
  bg?: string;
  bd?: string;
  fw?: 1;
}

export interface PageModel {
  doc: string;
  url: string;
  title: string;
  refs: number;
  vw: number;
  vh: number;
  dh: number;
  sy: number;
  bg?: string; // the page's background and text colors
  fg?: string;
  pics?: { r: Rect; alt: string; ov?: string; bg?: 1 | 2 }[];
  root: El | null;
}

export interface Rendered {
  header: string[]; // title, then url · refs · viewport
  body: string[];
  links: string[]; // "[7] https://…" for every link, in ref order
  hrefs: [number, string][]; // the same, as [ref, address]
  labels: Map<number, string>; // ref → how it appears, e.g. `[8 button "Save"]`
  layout: LayoutGroup[];
  visual: Visual;
}

/**
 * Blocks that sit side by side on the page, as ranges of body lines, for
 * clients that can draw columns (the terminal UI). The text itself stays
 * linear. `depth` counts the groups this one is nested in; `w` is the
 * block's width on the page, in pixels.
 */
export interface LayoutGroup {
  depth: number;
  cells: { start: number; end: number; w: number }[];
}

/**
 * Where things were on the page and how they looked, for drawing it (page
 * pixels). Dialogs floating over the page (modals, consent notices) are
 * layers: `layer` on a box, background or picture is its number in `layers`,
 * counting from 1, and what has none is the page itself.
 */
export interface Visual {
  width: number;
  height: number; // the page's, for telling when it grew
  canvas: string; // page background color
  text: string; // page text color
  boxes: { r: Rect; fg?: string; bold?: 1; table?: 1; layer?: number }[]; // a table's lines are its rows, `| a | b |`
  lines: number[][]; // for each body line, the boxes its text came from
  decor: { r: Rect; bg?: string; bd?: string; layer?: number }[]; // backgrounds and card borders
  images: { r: Rect; alt: string; layer?: number; bg?: 1 | 2 }[]; // bg: a CSS background, 1 a picture, 2 a gradient
  layers: { r: Rect; bg?: string; bd?: string }[];
  refs: Record<number, { fg?: string; bg?: string }>;
}

// ARIA landmark roles, shown by the names people use for them.
const LANDMARK_NAMES: Record<string, string> = {
  banner: 'header',
  navigation: 'nav',
  complementary: 'aside',
  contentinfo: 'footer',
};

const MAX_ROW = 160; // don't join side-by-side blocks into lines longer than this
const MAX_ALIGNED_CELL = 40; // pad table columns only when every cell is at most this wide

/** Where a placed block's lines are, and the page boxes of its first and last parts. */
interface Entry {
  start: number;
  end: number;
  first?: Rect;
  last?: Rect;
}

interface State {
  lines: string[];
  buf: string; // the inline run being accumulated
  last: { r?: Rect; single: boolean } | null; // previous block, for side-by-side joining
  entries: Entry[];
}

// Marker lines bracket side-by-side groups while rendering; renderParts takes
// them out again. They must never count as content.
const MARK = '\u0000';
const isMarker = (l: string) => l.includes(MARK);
const nonEmpty = (l: string) => l.trim() !== '' && !isMarker(l);

// A tag in front of a line's text names the page box it came from. Tags are
// taken out with the markers, so anything measuring or matching a line must
// look past them.
const TAG = /\u0001(\d+)\u0002/g;
const stripTags = (l: string) => l.replace(TAG, '');
const visibleLength = (l: string) => stripTags(l).length;

const quote = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`;

function sameRow(a: Rect, b: Rect): boolean {
  const overlap = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return overlap > 0 && overlap >= 0.5 * Math.min(a[3], b[3]) && b[0] >= a[0] + a[2] - 2;
}

export function renderParts(page: PageModel): Rendered {
  const r = new Renderer();
  const { body, layout, lineBoxes } = extractLayout(tidy(page.root ? r.block(page.root) : []));
  let meta = `${page.url} · ${page.refs} refs`;
  if (page.dh > page.vh + 10) meta += ` · viewport ${page.sy}–${page.sy + page.vh} of ${page.dh}px`;
  const hrefs = [...r.hrefs].sort((a, b) => a[0] - b[0]);
  const links = hrefs.map(([ref, href]) => `[${ref}] ${href}`);
  const visual: Visual = {
    width: page.vw,
    height: page.dh,
    canvas: page.bg ?? '#ffffff',
    text: page.fg ?? '#000000',
    boxes: r.boxes,
    lines: lineBoxes,
    decor: r.decor,
    images: (page.pics ?? []).map(({ r: box, alt, ov, bg }) => {
      const layer = ov ? r.layerOf.get(ov) : undefined;
      return { r: box, alt, ...(layer ? { layer } : {}), ...(bg ? { bg } : {}) };
    }),
    layers: r.layers,
    refs: r.refStyles,
  };
  return { header: [page.title || '(untitled)', meta], body, links, hrefs, labels: r.labels, layout, visual };
}

export function render(page: PageModel, { links = false } = {}): string {
  const p = renderParts(page);
  const out = [...p.header, '', ...p.body];
  if (links && p.links.length) out.push('', '── links ──', ...p.links);
  return out.join('\n');
}

class Renderer {
  hrefs = new Map<number, string>();
  labels = new Map<number, string>();
  boxes: Visual['boxes'] = [];
  decor: Visual['decor'] = [];
  layers: Visual['layers'] = [];
  layerOf = new Map<string, number>(); // a floating dialog's id from the page → its layer
  refStyles: Visual['refs'] = {};
  private groups = 0;
  private layer = 0; // the layer being rendered, 0 for the page

  // ---- tokens -------------------------------------------------------------

  private refToken(n: El): string {
    this.refStyle(n);
    if (n.k === 'link') {
      if (n.href) this.hrefs.set(n.ref!, n.href);
      // Link text like "[1]" (citations) would read as another ref, so drop its brackets.
      const t = `[${n.ref}]${(n.n ?? '').replace(/^\[(.+)\]$/, '$1')}`;
      this.labels.set(n.ref!, t);
      return n.s?.length ? `${t} (${n.s.join(', ')})` : t;
    }
    const named = `${n.ref} ${n.k}${n.n ? ` ${quote(n.n)}` : ''}`;
    this.labels.set(n.ref!, `[${named}]`); // actions describe the element without its current value
    return `[${named}${n.v ? ` = ${quote(n.v)}` : ''}${n.s?.length ? ` ${n.s.join(' ')}` : ''}]`;
  }

  private refPrefix(n: El): string {
    this.refStyle(n);
    if (n.k === 'link' && n.href) this.hrefs.set(n.ref!, n.href);
    return n.k === 'link' ? `[${n.ref}]` : `[${n.ref} ${n.k}]`;
  }

  private refStyle(n: El) {
    if (n.fg || n.bg) this.refStyles[n.ref!] = { fg: n.fg, bg: n.bg };
  }

  private embedToken(n: El): string {
    if (n.tag === 'img') return `[img ${quote(n.alt ?? '')}]`;
    const what = n.tag === 'iframe' ? 'iframe' : n.kind ?? 'embed';
    return n.n ? `[${what} ${quote(n.n)}]` : `[${what}]`;
  }

  // ---- page boxes -----------------------------------------------------------

  /** Tag the lines this element produced itself (inner blocks tagged theirs already) with its box. */
  private tag(lines: string[], n: El): string[] {
    if (!n.r) return lines; // its parent's box will do
    const layer = this.layer || undefined;
    const id = this.boxes.push({ r: n.r, fg: n.fg, bold: n.fw, table: n.rows ? 1 : undefined, layer }) - 1;
    // A layer's own background and border are the layer's (drawn with it as a card).
    if ((n.bg || n.bd) && !n.ov) this.decor.push({ r: n.r, bg: n.bg, bd: n.bd, layer });
    return lines.map((l) => (l.trim() && !isMarker(l) && !l.includes('\u0001') ? `\u0001${id}\u0002${l}` : l));
  }

  // ---- flow ---------------------------------------------------------------

  private fresh(): State {
    return { lines: [], buf: '', last: null, entries: [] };
  }

  private flush(st: State) {
    const s = st.buf.replace(/[ \t]+/g, ' ').trim();
    st.buf = '';
    if (s) {
      st.lines.push(s);
      st.last = null;
    }
  }

  private append(st: State, token: string) {
    // Keep adjacent tokens apart even when the markup has no whitespace between them.
    if (st.buf && !/[\s(\[]$/.test(st.buf)) st.buf += ' ';
    st.buf += token;
  }

  /** Put a rendered block into the flow, joining it to the previous one if they share a row. */
  private place(lines: string[], r: Rect | undefined, st: State) {
    if (!lines.some(nonEmpty)) return;
    const single = lines.length === 1;
    const prev = st.last;
    const lastLine = st.lines[st.lines.length - 1];
    if (
      prev?.single && single && prev.r && r && sameRow(prev.r, r) &&
      lastLine !== undefined && visibleLength(lastLine) + visibleLength(lines[0]) < MAX_ROW
    ) {
      st.lines[st.lines.length - 1] = lastLine + '  ' + lines[0];
      const joined = st.entries[st.entries.length - 1];
      if (joined) joined.last = r;
    } else {
      const start = st.lines.length;
      st.lines.push(...lines);
      st.entries.push({ start, end: st.lines.length, first: r, last: r });
    }
    st.last = { r, single };
  }

  /**
   * Bracket runs of placed blocks that sit side by side on the page (at least
   * one of them taller than a line) with marker lines. Works backwards so the
   * line indexes stay valid.
   */
  private markGroups(lines: string[], entries: Entry[]) {
    const runs: Entry[][] = [];
    for (const e of entries) {
      const run = runs[runs.length - 1];
      const prev = run?.[run.length - 1];
      if (prev && prev.end === e.start && prev.last && e.first && sameRow(prev.last, e.first)) run.push(e);
      else runs.push([e]);
    }
    for (const run of runs.reverse()) {
      if (run.length < 2 || run.every((e) => e.end - e.start <= 1)) continue;
      const id = this.groups++;
      for (let k = run.length - 1; k >= 0; k--) {
        const e = run[k];
        const width = e.first && e.last ? e.last[0] + e.last[2] - e.first[0] : 0;
        if (k === run.length - 1) lines.splice(e.end, 0, `${MARK}end:${id}`);
        lines.splice(e.start, 0, `${MARK}${k === 0 ? 'open' : 'cell'}:${id}:${width}`);
      }
    }
  }

  private node(n: Node, st: State) {
    if (typeof n === 'string') {
      st.buf += n;
      return;
    }
    if (n.tag === 'br') {
      this.flush(st);
      return;
    }
    const structural = n.h || n.list || n.rows || n.txt !== undefined || n.lm;
    if (n.d === 'i' && !structural) {
      if (n.ref && !n.c) return this.append(st, this.refToken(n));
      if (n.tag === 'img' || n.tag === 'iframe' || n.tag === 'embed') return this.append(st, this.embedToken(n));
      if (n.ref) this.append(st, this.refPrefix(n));
      if (n.box) st.buf += ' ';
      for (const c of n.c ?? []) this.node(c, st);
      if (n.box) st.buf += ' ';
      return;
    }
    this.flush(st);
    // A floating dialog never shares a line with what it happens to sit beside.
    this.place(this.block(n), n.ov ? undefined : n.r, st);
  }

  private contents(children: Node[] = []): string[] {
    const st = this.fresh();
    for (const c of children) this.node(c, st);
    this.flush(st);
    this.markGroups(st.lines, st.entries);
    return st.lines;
  }

  private inlineText(children: Node[] = []): string {
    return this.contents(children).filter(nonEmpty).map(stripTags).join(' ');
  }

  // ---- blocks -------------------------------------------------------------

  block(n: El): string[] {
    const outer = this.layer;
    if (n.ov && n.r) {
      this.layer = this.layers.push({ r: n.r, bg: n.bg, bd: n.bd });
      this.layerOf.set(n.ov, this.layer);
    }
    const lines = this.blockLines(n);
    this.layer = outer;
    return lines;
  }

  private blockLines(n: El): string[] {
    let lines: string[];
    if (n.h) lines = ['', '#'.repeat(n.h) + ' ' + this.inlineText(n.c)];
    else if (n.txt !== undefined) lines = ['```', ...n.txt.split('\n'), '```'];
    else if (n.rows) lines = this.table(n);
    else if (n.list) lines = this.list(n);
    else if (n.tag === 'img' || n.tag === 'iframe' || n.tag === 'embed') lines = [this.embedToken(n)];
    else if (n.ref && !n.c) lines = [this.refToken(n)];
    else if (n.ref) lines = this.container(n);
    else lines = this.contents(n.c);

    if (n.bq) lines = lines.map((l) => '> ' + l);
    if (n.lm && lines.some(nonEmpty)) {
      const label = `${LANDMARK_NAMES[n.lm] ?? n.lm}${n.lmn ? ` ${quote(n.lmn)}` : ''}`;
      const first = lines.findIndex(nonEmpty);
      const firstText = stripTags(lines[first]);
      // A landmark that opens straight into another one shares its divider: ── header › nav ──
      if (firstText.startsWith('── ')) {
        const markers = lines.slice(0, first).filter(isMarker);
        lines = ['', ...markers, `── ${label} › ${firstText.slice(3)}`, ...lines.slice(first + 1)];
      } else {
        lines = ['', `── ${label} ──`, ...lines];
      }
    }
    return this.tag(lines, n);
  }

  /** A link or click target wrapping a whole card: its content, with the ref in front. */
  private container(n: El): string[] {
    const lines = this.contents(n.c);
    const prefix = this.refPrefix(n);
    const i = lines.findIndex(nonEmpty);
    if (i < 0) return [prefix];
    const out = lines.slice();
    const m = /^((?:\u0001\d+\u0002)?)(#{1,6} )(.*)$/.exec(out[i]); // keep a heading's #'s in front
    out[i] = m ? m[1] + m[2] + prefix + m[3] : prefix + out[i];
    const text = stripTags(m ? m[3] : lines[i]).trim();
    this.labels.set(n.ref!, prefix + (text.length > 60 ? text.slice(0, 59) + '…' : text));
    return out;
  }

  private list(n: El): string[] {
    type Item = { lines: string[]; r?: Rect; li: boolean };
    const items: Item[] = [];
    for (const c of n.c ?? []) {
      if (typeof c === 'string') continue; // whitespace between items
      const lines = c.li ? this.tag(this.contents(c.c), c) : this.block(c);
      if (lines.some(nonEmpty)) items.push({ lines, r: c.r, li: !!c.li });
    }

    // Items laid out side by side (a horizontal nav, a row of tags) share a line, unmarked.
    const rows: Item[][] = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      const prev = row?.[row.length - 1];
      if (prev && prev.lines.length === 1 && it.lines.length === 1 && prev.r && it.r && sameRow(prev.r, it.r)) row.push(it);
      else rows.push([it]);
    }

    const out: string[] = [];
    const entries: Entry[] = [];
    let i = n.start ?? 1;
    for (const row of rows) {
      const start = out.length;
      if (row.length > 1) {
        let line = '';
        for (const it of row) {
          if (line && visibleLength(line) + visibleLength(it.lines[0]) > MAX_ROW) {
            out.push(line);
            line = '';
          }
          line = line ? line + '  ' + it.lines[0] : it.lines[0];
        }
        out.push(line);
        i += row.length;
      } else if (!row[0].li) {
        out.push(...row[0].lines);
      } else {
        const marker = n.list === 'ol' ? `${i++}.` : '-';
        const pad = ' '.repeat(marker.length + 1);
        const lines = row[0].lines;
        const first = lines.findIndex(nonEmpty);
        lines.forEach((l, j) => {
          if (isMarker(l)) out.push(l);
          else if (j >= first) out.push((j === first ? marker + ' ' : pad) + l);
        });
      }
      entries.push({ start, end: out.length, first: row[0].r, last: row[row.length - 1].r });
    }
    // Multi-line items side by side (a row of cards) form a group too.
    this.markGroups(out, entries);
    return out;
  }

  private table(n: El): string[] {
    const rows = n.rows!.map((r) => r.map((cell) => ({ th: cell.th, s: this.inlineText(cell.c).replace(/\|/g, '\\|') })));
    const out: string[] = n.cap ? ['', `Table: ${n.cap}`] : [''];
    const ncol = Math.max(...rows.map((r) => r.length));
    if (ncol <= 1) return [...out, ...rows.map((r) => r[0]?.s ?? '').filter(nonEmpty), ''];

    const widths = Array.from({ length: ncol }, (_, j) => Math.max(3, ...rows.map((r) => (r[j]?.s ?? '').length)));
    const aligned = widths.every((w) => w <= MAX_ALIGNED_CELL);
    const cellAt = (r: { s: string }[], j: number) => {
      const s = r[j]?.s ?? '';
      return aligned ? s.padEnd(widths[j]) : s;
    };
    rows.forEach((r, i) => {
      const cols = aligned ? ncol : r.length;
      out.push('| ' + Array.from({ length: cols }, (_, j) => cellAt(r, j)).join(' | ') + ' |');
      if (i === 0 && r.every((c) => c.th)) {
        out.push('|' + Array.from({ length: cols }, (_, j) => '-'.repeat(aligned ? widths[j] + 2 : 5)).join('|') + '|');
      }
    });
    out.push('');
    return out;
  }
}

/**
 * Take the marker lines and box tags out, noting where each side-by-side
 * group's cells fall in what's left and which boxes each line came from.
 */
function extractLayout(lines: string[]): { body: string[]; layout: LayoutGroup[]; lineBoxes: number[][] } {
  const body: string[] = [];
  const lineBoxes: number[][] = [];
  const layout: LayoutGroup[] = [];
  const open: LayoutGroup[] = [];
  for (const line of lines) {
    const at = line.indexOf(MARK);
    if (at < 0) {
      // A marker can separate blank lines that tidy() would otherwise have merged.
      if (line === '' && (body.length === 0 || body[body.length - 1] === '')) continue;
      body.push(stripTags(line));
      lineBoxes.push([...line.matchAll(TAG)].map((m) => Number(m[1])));
      continue;
    }
    const [kind, , width] = line.slice(at + 1).split(':');
    const cell = { start: body.length, end: body.length, w: Number(width) || 0 };
    const group = open[open.length - 1];
    if (kind === 'open') {
      open.push({ depth: open.length, cells: [cell] });
    } else if (kind === 'cell') {
      group.cells[group.cells.length - 1].end = body.length;
      group.cells.push(cell);
    } else {
      group.cells[group.cells.length - 1].end = body.length;
      layout.push(open.pop()!);
    }
  }
  while (body[body.length - 1] === '') {
    body.pop();
    lineBoxes.pop();
  }
  for (const c of layout.flatMap((g) => g.cells)) {
    c.start = Math.min(c.start, body.length);
    c.end = Math.min(c.end, body.length);
  }
  return { body, layout, lineBoxes };
}

/** Strip trailing whitespace and collapse runs of blank lines. */
function tidy(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (l) out.push(l);
    else if (out.length && out[out.length - 1] !== '') out.push('');
  }
  while (out[0] === '') out.shift();
  while (out[out.length - 1] === '') out.pop();
  return out;
}
