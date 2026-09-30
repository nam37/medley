// A long-lived browser session: one active page, actions addressed by the refs
// in its snapshots, and a baseline per client so each action reports only what
// changed since that client last looked.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditText, type AuditResult } from './audit.ts';
import { Browser, NoAnswer, sleep, type Dialog, type DownloadEvent, type LaunchOptions, type Page, type RequestEntry } from './browser.ts';
import { countOf, meansOn, type Check, type State } from './checks.ts';
import { diffLines, fencedLines, whereIs } from './diff.ts';
import { inspectText, type Found, type Inspection } from './inspect.ts';
import { ABOUT, siteOf, type About, type PageInfo } from './info.ts';
import { parseKey } from './keys.ts';
import { matchRef, parseLabel } from './names.ts';
import type { RecordingStatus } from './script.ts';
import { refTokens } from './tokens.ts';
import { mainText, pageData, renderParts, type El, type LayoutGroup, type PageData, type PageModel, type Visual } from './render.ts';

const SETTLE_S = 15; // see Page.settle

/** Said when the page doesn't answer (see Page.responsive). */
const STUCK = "the page isn't answering: a script on it seems stuck (reload stops it)";

/** Said when a page was stuck in a script and medley stopped it (see Page.unstick). */
const UNSTUCK = 'the page was stuck in a script and answered nothing; medley stopped the script first';

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const EXTRACT = read('./extract.js');
const ACTIONS = read('./page-actions.js');
// Page-side helpers the two below share: each is a script with LIB as a name it may use.
const LIB = read('./page-lib.js');
const AUDIT = `((LIB) => ${read('./audit.js')})(${LIB})`;
const INSPECT = `((LIB) => ${read('./inspect.js')})(${LIB})`;

/**
 * A diff says what changed, which a full page doesn't, so prefer it unless
 * more than this share of all lines (before and after) changed, as when a
 * single-page app swaps out its whole view.
 */
const MAX_CHURN = 0.5;

interface Snap {
  doc: string;
  url: string;
  title: string;
  header: string[];
  body: string[];
  links: string[];
  hrefs: [number, string][];
  labels: Map<number, string>;
  layout: LayoutGroup[];
  visual: Visual;
}

/** A JPEG of the whole page, scaled down; `width` and `height` are in page pixels. */
export interface Screenshot {
  image: string; // base64 of a JPEG, or of a PNG when asked for
  width: number;
  height: number;
  scale: number;
}

/**
 * How an action reports: `full`, the whole page; `showScroll`, where the
 * window is; `across`, what changed even when the page loaded anew (a reload
 * of a page being edited), as a diff that ignores renumbered refs.
 */
type Outcome = { full?: boolean; showScroll?: boolean; across?: boolean };

/** What a client that draws the page itself (the terminal UI) needs after a command. */
export interface View {
  dialog: Dialog | null;
  recording?: RecordingStatus | null; // added by the daemon, which does the recording (see script.ts)
  tabs: { current: number; count: number };
  page: {
    doc: string;
    url: string;
    title: string;
    body: string[];
    labels: [number, string][];
    hrefs: [number, string][];
    layout: LayoutGroup[];
    visual: Visual;
  } | null;
}

/** "a", "a and b", "a, b and c" */
function joinAnd(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** 812 B, 1.2 kB, 3.4 MB */
function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

const progress = (received: number, total: number) => (total ? `${size(received)} of ${size(total)}` : `${size(received)} so far`);

const TOP = 'top';
const KEY_SEP = '|';

/**
 * Page-wide ref numbers. Each document (the page's, and each cross-origin
 * frame's) numbers its own elements; this gives each (document, number) pair
 * one number for the whole page, keeping the page's own numbers wherever it
 * can, so a page without such frames reads exactly as its own numbering.
 */
class RefMap {
  private toGlobal = new Map<string, number>();
  private fromGlobal = new Map<number, { key: string; local: number }>();
  private next = 1;

  global(key: string, local: number): number {
    const id = `${key}${KEY_SEP}${local}`;
    let g = this.toGlobal.get(id);
    if (g !== undefined) return g;
    g = key === TOP && !this.fromGlobal.has(local) ? local : this.next;
    while (this.fromGlobal.has(g)) g++;
    this.toGlobal.set(id, g);
    this.fromGlobal.set(g, { key, local });
    this.next = Math.max(this.next, g + 1);
    return g;
  }

  resolve(global: number): { key: string; local: number } | undefined {
    return this.fromGlobal.get(global);
  }

  /** A frame's ref as the page knows it, without numbering it if it's new. */
  lookup(key: string, local: number): number | undefined {
    return this.toGlobal.get(`${key}${KEY_SEP}${local}`);
  }
}

/** A ref that a modal covers; `refs` are what can be pressed in the modal (page-wide numbers). */
class Covered extends Error {
  constructor(message: string, readonly refs: number[]) {
    super(message);
  }
}

/**
 * Give every ref in a model tree its page-wide number and shift its boxes by
 * (dx, dy); returns the frame placeholders found (to be read and filled in).
 */
function renumber(root: El | null, global: (ref: number) => number, dx: number, dy: number): El[] {
  const frames: El[] = [];
  const visit = (n: El) => {
    if (n.ref !== undefined) n.ref = global(n.ref);
    if (n.r && (dx || dy)) n.r = [n.r[0] + dx, n.r[1] + dy, n.r[2], n.r[3]];
    if (n.tag === 'iframe' && n.frame) frames.push(n);
    for (const c of n.c ?? []) if (typeof c === 'object') visit(c);
    for (const row of n.rows ?? []) for (const cell of row) for (const c of cell.c) if (typeof c === 'object') visit(c);
  };
  if (root) visit(root);
  return frames;
}

/** Whether a model still has an iframe placeholder (a frame not read in). */
function hasPlaceholder(root: El | null): boolean {
  const visit = (n: El): boolean =>
    n.tag === 'iframe' || (n.c ?? []).some((c) => typeof c === 'object' && visit(c)) ||
    (n.rows ?? []).some((row) => row.some((cell) => cell.c.some((c) => typeof c === 'object' && visit(c))));
  return !!root && visit(root);
}

// ---- outlines: long pages in parts ---------------------------------------------

interface Part {
  line: number; // where it starts in the body
  level: number; // 0 for a region (── nav ──), 1-6 for a heading
  name: string; // the heading's or region's text, without its # or ── marks
  text: string; // the line as shown
}

/** The regions and headings of a page, in order (not the ones in its code: see fencedLines). */
function partsOf(body: string[]): Part[] {
  const parts: Part[] = [];
  const code = fencedLines(body);
  body.forEach((text, line) => {
    if (code[line]) return;
    const heading = /^(#{1,6}) (.*)$/.exec(text);
    if (heading) parts.push({ line, level: heading[1].length, name: heading[2], text });
    else if (/^── .* ──$/.test(text)) parts.push({ line, level: 0, name: text.slice(3, -3), text });
  });
  return parts;
}

/** Where a part ends: at the next part of the same or a higher level. */
function partEnd(parts: Part[], i: number, total: number): number {
  const p = parts[i];
  const next = parts.slice(i + 1).find((q) => (p.level === 0 ? q.level === 0 : q.level <= p.level));
  return next ? next.line : total;
}

/** The page as its regions and headings, each with how much it holds. */
function outlineText(s: Snap): string {
  const parts = partsOf(s.body);
  // Refs in the page's code (an example of a snapshot), or text that looks like one, aren't refs.
  const code = fencedLines(s.body);
  const refCount = (from: number, to: number) => {
    let n = 0;
    for (let i = from; i < to; i++) if (!code[i]) n += refTokens(s.body[i], s.labels).length;
    return n;
  };
  const refs = refCount(0, s.body.length);
  const lines = parts.map((p, i) => {
    const end = partEnd(parts, i, s.body.length);
    const inner = s.body.slice(p.line + 1, end);
    const own = refCount(p.line + 1, end);
    const size = `${inner.filter((l) => l.trim()).length} lines${own ? `, ${own} refs` : ''}`;
    return `${p.level > 1 ? '  '.repeat(p.level - 1) : ''}${p.text}  (${size})`;
  });
  return [
    ...s.header,
    '',
    `outline: ${s.body.length} lines, ${refs} refs · to read a part, ask for its section by name`,
    ...(lines.length ? lines : ['(no headings or regions; this page is one part)']),
  ].join('\n');
}

/** One part of the page, found by name (exactly, then as the start, then anywhere in it). */
function sectionText(s: Snap, name: string): string {
  const parts = partsOf(s.body);
  const want = name.trim().toLowerCase();
  const plain = (p: Part) => p.name.replace(/\[\d+\]/g, '').trim().toLowerCase();
  const i = [
    parts.findIndex((p) => plain(p) === want),
    parts.findIndex((p) => plain(p).startsWith(want)),
    parts.findIndex((p) => plain(p).includes(want)),
  ].find((n) => n >= 0);
  if (i === undefined) {
    const names = parts.slice(0, 40).map((p) => p.name).join(' · ');
    throw new Error(`no part of the page is called "${name}"; ${parts.length ? `its parts: ${names}` : 'it has no headings or regions'}`);
  }
  const end = partEnd(parts, i, s.body.length);
  return [...s.header, '', `section "${parts[i].name}" · lines ${parts[i].line + 1}–${end} of ${s.body.length}`, ...s.body.slice(parts[i].line, end)].join('\n');
}

/** The page's main text only, as a reader view shows it; all of the page when it has none to single out. */
function readerText(s: Snap): string {
  const lines = mainText(s.body, s.visual);
  const count = (l: string[]) => l.filter((x) => x.trim()).length;
  if (!lines) {
    return [...s.header, '', "reader: this page has no main text to single out (it isn't an article), so here is all of it", '', ...s.body].join('\n');
  }
  const note = `reader: the page's main text, ${count(lines)} of ${count(s.body)} lines (menus, sidebars and footers left out)`;
  return [...s.header, '', note, '', ...lines].join('\n');
}

// ---- data, the console and the network -----------------------------------------------

/** What extract can give: the tables and runs of items, numbered, with where they are. */
function dataList(s: Snap, data: PageData): string {
  const out = [...s.header, ''];
  if (!data.tables.length && !data.lists.length) return [...out, 'extract: this page has no tables or runs of repeated items'].join('\n');
  if (data.tables.length) {
    out.push('tables:');
    data.tables.forEach((t, i) => {
      const cols = Math.max(t.header?.length ?? 0, ...t.rows.map((r) => r.length));
      const name = t.caption ? ` "${t.caption}"` : t.header ? ` (${t.header.slice(0, 4).join(', ')}${t.header.length > 4 ? ', …' : ''})` : '';
      out.push(`  ${i + 1}.${name} ${plural(t.rows.length, 'row')} × ${plural(cols, 'column')}${t.where ? ` · ${t.where}` : ''}`);
    });
  }
  if (data.lists.length) {
    out.push('runs of items:');
    data.lists.forEach((l, i) => {
      const first = l.items[0]?.link || l.items[0]?.text || '';
      out.push(`  ${i + 1}. ${plural(l.items.length, 'item')}${l.where ? ` · ${l.where}` : ''} · first: ${first.length > 60 ? first.slice(0, 59) + '…' : first}`);
    });
  }
  out.push('', 'get one with: extract table <n> (JSON rows, or --csv), extract items <n>');
  return out.join('\n');
}

const csvRow = (cells: string[]) => cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

/** A script and line, short: app.js:12. */
const shortWhere = (where: string) => /([^/?#]+?(?::\d+)?)$/.exec(where.replace(/[?#][^:]*/, ''))?.[1] ?? where;

/** A request that went wrong: an error status, or a failure other than being canceled. */
const requestFailed = (r: RequestEntry) => (r.status !== undefined && r.status >= 400) || (!!r.failed && r.failed !== 'canceled');

/** How a request went wrong: its error status, or why it got none. */
const failure = (r: RequestEntry) => (r.failed && r.failed !== 'canceled' ? r.failed : String(r.status ?? r.failed ?? '…'));

// How long a check waits for the page to answer; a stuck page gets no more than this per look.
const PROBE_MS = 2000;

/** What a wait or a check says when the page never answered it: it doesn't know, rather than guessing. */
const couldntTell = (claim: string, seconds: number) =>
  `couldn't tell whether ${claim}: the page didn't answer for ${seconds}s (a script on it may be stuck; reload stops it)`;

/** What checks read from the page (page-actions.js facts): how many times it has each text, and whether its title does. */
interface Facts {
  url: string;
  title: string;
  counts: number[];
  titled: boolean[];
}

/** What checks read from an element (page-actions.js state); a state it doesn't have is null. */
interface ElState {
  error?: string;
  value: string | null;
  alt?: string; // a select's chosen option, by its value
  select: boolean;
  secret: boolean;
  checked: boolean | null;
  disabled: boolean;
  focused: boolean;
  expanded: boolean | null;
  selected: boolean | null;
  pressed: boolean | null;
  active: number | null; // what has the focus: its ref in its document, and how it looks
  activeText: string;
}

/** An element a check names, once found on the page. */
interface Named {
  ref: number;
  label: string;
}

/**
 * How a check stands: so, not so, or unknown (null: the page didn't answer).
 * `said` is what's so, what was expected and what is instead, or what
 * couldn't be told.
 */
interface Verdict {
  ok: boolean | null;
  said: string;
}

const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** A field's text in a message: in quotes, cut if long; a password's is never shown. */
const held = (text: string, secret = false) => (secret ? 'the text given' : `"${text.length > 80 ? text.slice(0, 79) + '…' : text}"`);

const KIND_WORDS: Record<string, [string, string]> = {
  textbox: ['textbox', 'textboxes'],
  combobox: ['combobox', 'comboboxes'],
  checkbox: ['checkbox', 'checkboxes'],
  password: ['password field', 'password fields'],
  radio: ['radio button', 'radio buttons'],
  file: ['file field', 'file fields'],
  menuitem: ['menu item', 'menu items'],
  draggable: ['draggable element', 'draggable elements'],
  clickable: ['clickable element', 'clickable elements'],
};
const kindWord = (kind: string, n: number) => (KIND_WORDS[kind] ?? [kind, `${kind}s`])[n === 1 ? 0 : 1];

/** A check of the page's text, address or title, against what the page says of them. */
function factVerdict(c: Extract<Check, { kind: 'text' | 'count' | 'url' | 'title' }>, facts: Facts | null, i: number): Verdict {
  const q = `"${c.text}"`;
  if (c.kind === 'url') {
    if (!facts) return { ok: null, said: `the address has ${q}` };
    if (facts.url.includes(c.text)) return { ok: true, said: `the address has ${q} (${facts.url})` };
    return { ok: false, said: `expected the address to have ${q}, but it's ${facts.url}` };
  }
  if (c.kind === 'title') {
    if (!facts) return { ok: null, said: `the title has ${q}` };
    if (facts.title.toLowerCase().includes(c.text.toLowerCase())) return { ok: true, said: `the title has ${q} ("${facts.title}")` };
    return { ok: false, said: `expected the title to have ${q}, but it's "${facts.title}"` };
  }
  if (c.kind === 'count') {
    if (!facts) return { ok: null, said: `${q} is on the page ${times(c.n)}` };
    const n = facts.counts[i];
    const is = n ? `on the page ${times(n)}` : 'not on the page';
    return n === c.n ? { ok: true, said: `${q} is ${is}` } : { ok: false, said: `expected ${q} ${times(c.n)}, but it's ${is}` };
  }
  if (!facts) return { ok: null, said: c.gone ? `${q} is gone` : `${q} is on the page` };
  const there = facts.counts[i] > 0 || facts.titled[i];
  if (c.gone) return there ? { ok: false, said: `expected ${q} to be gone, but it's still on the page` } : { ok: true, said: `${q} isn't on the page` };
  return there ? { ok: true, said: `${q} is on the page` } : { ok: false, said: `expected ${q} on the page, but it isn't there` };
}

/** A check of what a field holds: exactly the text; a select's option by its text or value; a checkbox on or off. */
function valueVerdict(text: string, label: string, st: ElState): Verdict {
  if (st.value === null && st.checked !== null) {
    const word = (on: boolean) => (on ? 'checked' : 'unchecked');
    const on = meansOn(text);
    return st.checked === on ? { ok: true, said: `${label} is ${word(on)}` } : { ok: false, said: `expected ${label} to be ${word(on)}, but it's ${word(st.checked)}` };
  }
  if (st.value === null) return { ok: false, said: `expected ${label} to hold ${held(text)}, but it isn't a field: it holds nothing` };
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const so = st.select ? same(st.value, text) || same(st.alt ?? '', text) : st.value === text;
  if (so) return { ok: true, said: `${label} holds ${held(st.value, st.secret)}` };
  const has = !st.value ? 'nothing' : st.secret ? 'something else' : held(st.value);
  return { ok: false, said: `expected ${label} to hold ${held(text, st.secret)}, but it holds ${has}` };
}

/** A line with its refs' numbers taken out, for comparing two loads of a page (see diffLines). */
const withoutRefs = (line: string) => line.replace(/\[\d+(?=[\] ])/g, '[#');

const fullText = (s: Snap, links = false) =>
  [...s.header, '', ...s.body, ...(links && s.links.length ? ['', '── links ──', ...s.links] : [])].join('\n');

export class Session {
  private baselines = new Map<string, Snap>();
  private dialog: Dialog | null = null; // an open confirm() or prompt(), waiting for an answer
  private dialogWaiters = new Set<() => void>();
  private notes: string[] = []; // things that happened on their own, reported with the next result
  private startedAt = Date.now();
  private tabs: Page[]; // open tabs, in the order they opened; `page` is the current one
  private openers = new Map<Page, Page>(); // the tab each popup came from, to return to when it closes
  private refs: { doc: string; map: RefMap } | null = null; // page-wide ref numbers for the current document
  private lastModel: PageModel | null = null; // the last page model read (for extract)
  private acting = 0; // commands running now; a navigation they cause is theirs to report
  private timing: { action?: number; settle?: number; read?: number } = {}; // the last command's, in ms
  private changePending = false;
  private downloads: { name: string; path: string; bytes: number }[] = []; // finished, in order
  private downloadsStarted = 0; // how many downloads have begun, to tell which ones an action started
  private downloadsRunning = new Set<string>();
  /**
   * Called with news from outside any command, for clients following along:
   * the current tab loaded a new document by itself (a redirect after a
   * "checking your browser" page, a meta refresh, a sign-in that finishes)
   * and has settled, or a download finished.
   */
  onNews: ((kind: 'navigated' | 'download', summary: string) => void) | null = null;

  private constructor(
    private browser: Browser,
    private page: Page,
  ) {
    this.tabs = [page];
    this.watch(page);
    browser.onTargetClosed = (targetId) => this.tabClosed(targetId);
    browser.onDownload = (e) => this.downloaded(e);
  }

  static async start(opts: LaunchOptions = {}): Promise<Session> {
    const browser = await Browser.launch(opts);
    return new Session(browser, await browser.newPage());
  }

  get exited(): Promise<void> {
    return this.browser.exited;
  }

  close() {
    return this.browser.close();
  }

  // ---- commands -----------------------------------------------------------

  goto(client: string, url: string, { links = false, outline = false, reader = false } = {}): Promise<string> {
    if (this.dialog) this.answerQuietly();
    const outcome: Outcome = { full: true };
    let what = `opened ${url}`;
    const open = async () => {
      const before = this.downloadsStarted;
      if (await this.page.unstick()) this.notes.push(UNSTUCK);
      try {
        await this.page.goto(url);
      } catch (e) {
        // An address that serves a file downloads it instead of opening a page,
        // which stays as it was: report it like an action, not a new page.
        await sleep(300);
        if (this.downloadsStarted === before || !/ERR_ABORTED/.test((e as Error).message)) throw e;
        outcome.full = false;
        what = `opened ${url}: it's a file, so it was downloaded`;
      }
    };
    return this.act(client, () => what, open, outcome).then((text) => {
      const snap = this.baselines.get(client)!;
      // The page's outline in place of the whole page (notes and any dialog stay).
      if (outline && outcome.full && !this.dialog) {
        return [...text.split('\n').filter((l) => l.startsWith('note: ')), outlineText(snap)].join('\n');
      }
      // Or its main text.
      if (reader && outcome.full && !this.dialog) {
        return [...text.split('\n').filter((l) => l.startsWith('note: ')), readerText(snap)].join('\n');
      }
      return links ? `${text}\n\n── links ──\n${snap.links.join('\n')}` : text;
    });
  }

  async snapshot(client: string, { diff = false, links = false, outline = false, section = '', reader = false } = {}): Promise<string> {
    if (this.dialog) return this.dialogText();
    await this.ensureTab();
    if (diff) return this.report(client, 'changes since your last look');
    const snap = await this.capture();
    this.baselines.set(client, snap);
    const page = section ? sectionText(snap, section) : outline ? outlineText(snap) : reader ? readerText(snap) : fullText(snap, links);
    return [...this.takeNotes(), page].join('\n');
  }

  async click(client: string, ref: number): Promise<string> {
    await this.checkRefs(client);
    return this.act(client, `clicked ${this.label(client, ref)}`, async () => {
      const at = await this.locate(ref);
      await this.page.click(at.x, at.y);
    });
  }

  async type(client: string, ref: number, text: string, submit = false): Promise<string> {
    await this.checkRefs(client);
    const what = `typed into ${this.label(client, ref)}${submit ? ' and pressed Enter' : ''}`;
    return this.act(client, what, async () => {
      await this.typeInto(ref, text);
      if (submit) await this.page.press(parseKey('Enter'));
    });
  }

  /** Replace a field's text the way typing would, so frameworks see ordinary input events. */
  private async typeInto(ref: number, text: string) {
    // Keys go to the focused frame, and a frame gets focus the way a person gives it: a click.
    if (this.target(ref).frame) {
      const at = await this.locate(ref);
      await this.page.click(at.x, at.y);
    }
    type Focused = { hasText?: boolean; error?: string; unfocused?: boolean };
    let r = await this.callRef<Focused>('focus', ref);
    if (r.unfocused) {
      // A widget that takes the focus only when clicked (a combobox that opens a search box):
      // click it, then type only if that put the focus in a text field of its own.
      const at = await this.locate(ref);
      await this.page.click(at.x, at.y);
      await sleep(150);
      r = await this.callRef<Focused>('focusAfterClick', ref);
    }
    if (r.error) throw new Error(r.error);
    if (text) await this.page.insertText(text);
    else if (r.hasText) await this.page.press(parseKey('Delete')); // clear the selected text
  }

  /**
   * Fill several fields in one go, and report the changes once: text fields
   * are typed into, selects get an option (by text or value), checkboxes and
   * radio buttons are checked ("on", "yes", "true") or unchecked ("off", "no").
   */
  async fill(client: string, fields: { ref: number; value: string }[], submit = false): Promise<string> {
    await this.checkRefs(client);
    const names = fields.map((f) => this.label(client, f.ref));
    const what = `filled ${joinAnd(names)}${submit ? ' and pressed Enter' : ''}`;
    return this.act(client, what, async () => {
      for (const { ref, value } of fields) {
        const label = this.label(client, ref);
        const kind = /^\[\d+ (\w+)/.exec(label)?.[1] ?? 'link';
        if (kind === 'select') {
          const r = await this.callRef<{ error?: string }>('select', ref, value);
          if (r.error) throw new Error(r.error);
        } else if (kind === 'checkbox' || kind === 'radio') {
          const want = !/^(off|no|false|0|unchecked)?$/i.test(value.trim());
          const r = await this.callRef<{ checked?: boolean; error?: string }>('checked', ref);
          if (r.error) throw new Error(r.error);
          if (r.checked === want) continue;
          if (kind === 'radio' && !want) throw new Error(`${label} is unchecked by checking another radio button`);
          const at = await this.locate(ref);
          await this.page.click(at.x, at.y);
        } else if (kind === 'textbox' || kind === 'password' || kind === 'combobox') {
          await this.typeInto(ref, value);
        } else if (kind === 'slider') {
          const r = await this.callRef<{ error?: string }>('setRange', ref, value);
          if (r.error) throw new Error(r.error);
        } else {
          throw new Error(`${label} isn't a field to fill; click it instead`);
        }
      }
      if (submit) await this.page.press(parseKey('Enter'));
    });
  }

  /**
   * Drag a ref onto another ref, or onto the visible text of a drop zone
   * (those are rarely controls). The source is scrolled into view; the
   * target is found where it is if it's on screen too, else brought just
   * into view and the source found again.
   */
  async drag(client: string, from: number, to: number | string): Promise<string> {
    await this.checkRefs(client);
    const onto = typeof to === 'number' ? this.label(client, to) : `"${to}"`;
    return this.act(client, `dragged ${this.label(client, from)} onto ${onto}`, async () => {
      const target = async (scroll: boolean) => {
        if (typeof to === 'number') return this.locate(to, scroll);
        const at = await this.page.evaluate<{ x: number; y: number; error?: string }>(`(${ACTIONS}).textPoint(${JSON.stringify(to)}, ${scroll})`);
        if (at.error) throw new Error(at.error);
        return at;
      };
      let a = await this.locate(from);
      let b: { x: number; y: number };
      try {
        b = await target(false);
      } catch {
        b = await target(true);
        a = await this.locate(from, false).catch(() => {
          throw new Error(`${this.label(client, from)} and ${onto} don't fit on screen together; scroll so both show, then drag`);
        });
      }
      await this.page.drag(a, b);
    });
  }

  /**
   * Wait (up to `seconds`) until `text` shows on the page, or with `gone`,
   * until it doesn't, checking every quarter second; then report the changes.
   * Not finding it isn't an error: the result says so, with what changed.
   */
  waitFor(client: string, text: string, { gone = false, seconds = 10 } = {}): Promise<string> {
    let what = '';
    return this.act(client, () => what, async () => {
      const start = Date.now();
      for (;;) {
        // Null when the page didn't answer (between documents, or stuck): that's no answer either way.
        // The page's title counts too: waiting for the next page is often waiting for its title.
        const seen = await this.facts([text]);
        const present = seen ? seen.counts[0] > 0 || seen.titled[0] : null;
        const took = ((Date.now() - start) / 1000).toFixed(1);
        if (present !== null && present !== gone) {
          what = gone ? `"${text}" went away after ${took}s` : `"${text}" appeared after ${took}s`;
          return;
        }
        if (Date.now() - start >= seconds * 1000) {
          if (present === null) throw new Error(couldntTell(`"${text}" ${gone ? 'went away' : 'appeared'}`, seconds));
          what = gone ? `"${text}" was still there after ${seconds}s` : `"${text}" didn't appear within ${seconds}s`;
          return;
        }
        await sleep(250);
      }
    });
  }

  /**
   * Check that things are so on the page (see checks.ts), waiting up to
   * `seconds` for all of them to be: some text is there (in the page's text
   * or title, in any case), or gone, or there so many times; the address or
   * the title has some text; a field holds a value; a control is in a state;
   * the page logged no errors. Not so by then is an error saying what is
   * instead: a script's check that failed (see script.ts). A page that didn't
   * answer is an error too, never a pass.
   */
  async expect(client: string, checks: Check[], seconds = 5): Promise<string> {
    if (!checks.length) throw new Error('expect needs something to check');
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    if (checks.some((c) => 'ref' in c && /^\d+$/.test(c.ref))) await this.checkRefs(client);
    if (checks.some((c) => c.kind === 'errors')) await this.hearConsole();
    const found = new Map<Check, Named>(); // the elements that checks name, once found on the page
    const start = Date.now();
    let verdicts: Verdict[];
    for (;;) {
      verdicts = await this.look(client, checks, found);
      if (verdicts.every((v) => v.ok)) break;
      if (this.dialog) throw new Error(this.dialogText());
      if (Date.now() - start >= seconds * 1000) throw new Error(await this.notSo(verdicts, seconds));
      await sleep(250);
    }
    // Text that's there: the line it's on, and where that is, as find shows it.
    const snap = checks.some((c) => c.kind === 'text' && !c.gone) ? await this.capture().catch(() => null) : null;
    const lines = verdicts.map((v, i) => {
      const c = checks[i];
      const at = snap && c.kind === 'text' && !c.gone ? snap.body.findIndex((l) => l.toLowerCase().includes(c.text.toLowerCase())) : -1;
      if (at < 0) return `ok: ${v.said}`;
      const where = whereIs(snap!.body, at);
      const line = snap!.body[at].trim();
      return `ok: ${v.said}${where ? ` · ${where}` : ''} · ${line.length > 120 ? line.slice(0, 119) + '…' : line}`;
    });
    return lines.join('\n');
  }

  /** How each check stands right now. */
  private async look(client: string, checks: Check[], found: Map<Check, Named>): Promise<Verdict[]> {
    // Text is looked for in the page's text; a count of a kind of element ("button Remove"), among its elements.
    const counted = (c: Check) => c.kind === 'text' || (c.kind === 'count' && !countOf(c.text));
    const texts = checks.filter(counted).map((c) => (c as { text: string }).text);
    const facts = checks.some((c) => counted(c) || c.kind === 'url' || c.kind === 'title') ? await this.facts(texts) : null;
    // The page as it is now, read once, and only if a check needs its elements.
    let reading: Promise<Snap | null> | undefined;
    const now = () => (reading ??= this.capture().catch(() => null));
    let text = 0;
    const out: Verdict[] = [];
    for (const c of checks) {
      if (c.kind === 'errors') out.push(this.errorsVerdict());
      else if (c.kind === 'value' || c.kind === 'state') out.push(await this.elementVerdict(client, c, found, now));
      else if (c.kind === 'count' && !counted(c)) out.push(await this.countVerdict(c, now));
      else out.push(factVerdict(c, facts, counted(c) ? text++ : -1));
    }
    return out;
  }

  /** What failed checks say: what was expected and what is instead, then what couldn't be told, then what was fine. */
  private async notSo(verdicts: Verdict[], seconds: number): Promise<string> {
    const failed = verdicts.filter((v) => v.ok === false).map((v) => v.said);
    const unknown = verdicts.filter((v) => v.ok === null).map((v) => couldntTell(v.said, seconds));
    const fine = verdicts.filter((v) => v.ok).map((v) => `ok: ${v.said}`);
    if (failed.length) {
      const at = await this.page.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })', PROBE_MS).catch(() => null);
      failed[0] += ` (after ${seconds}s${at ? `; the page is "${at.title || '(untitled)'}", ${at.url}` : ''})`;
    }
    return [...failed, ...unknown, ...fine].join('\n');
  }

  /**
   * The page's address and title, and how many times its text has each of
   * `texts`, in its frames too; null when it didn't answer (between
   * documents, or stuck in a script).
   */
  private async facts(texts: string[]): Promise<Facts | null> {
    const ask = `(${ACTIONS}).facts(${JSON.stringify(texts)})`;
    const top = await this.page.evaluate<Facts>(ask, PROBE_MS).catch(() => null);
    if (!top || !texts.length) return top;
    // Frames from other sites keep their text to themselves: each is asked.
    const inner = await Promise.all(this.page.crossSiteFrames.map((f) => this.page.evaluateIn<Facts>(f, ask, PROBE_MS).catch(() => null)));
    for (const f of inner) f?.counts.forEach((n, i) => (top.counts[i] += n));
    return top;
  }

  /** How many elements of a kind there are ("button Remove": buttons with Remove in their names), as snapshots show them. */
  private async countVerdict(c: { text: string; n: number }, now: () => Promise<Snap | null>): Promise<Verdict> {
    const { kind, name } = countOf(c.text)!;
    const many = (n: number) => `${n || 'no'} ${kindWord(kind, n)}${name ? ` called "${name}"` : ''}`;
    const are = (n: number) => `there ${n === 1 ? 'is' : 'are'} ${many(n)}`;
    const snap = await now();
    if (!snap) return { ok: null, said: are(c.n) };
    const fit = [...snap.labels.values()].filter((label) => {
      const l = parseLabel(label);
      return l.kind === kind && l.name.toLowerCase().includes(name.toLowerCase());
    });
    if (fit.length === c.n) return { ok: true, said: are(c.n) };
    const list = fit.length ? `: ${fit.slice(0, 6).join(', ')}${fit.length > 6 ? ', …' : ''}` : '';
    return { ok: false, said: `expected ${many(c.n)}, but ${are(fit.length)}${list}` };
  }

  /**
   * A check of an element: what it holds, or a state it's in. One given by
   * name is looked for on the page as it is now, and again if the page has
   * since drawn it anew; a name that fits several is an error, not a wait.
   */
  private async elementVerdict(
    client: string,
    c: Extract<Check, { kind: 'value' | 'state' }>,
    found: Map<Check, Named>,
    now: () => Promise<Snap | null>,
  ): Promise<Verdict> {
    const so = (label: string) =>
      c.kind === 'state' ? `${label} is ${c.state}` : `${label} holds ${held(c.text, parseLabel(label).kind === 'password')}`;
    const wanted = (label: string) =>
      `expected ${label} ${c.kind === 'state' ? `to be ${c.state}` : `to hold ${held(c.text, parseLabel(label).kind === 'password')}`}`;
    const numbered = /^\d+$/.test(c.ref);
    let el = numbered ? { ref: Number(c.ref), label: this.label(client, Number(c.ref)) } : found.get(c);
    if (!el) {
      const snap = await now();
      if (!snap) return { ok: null, said: so(`"${c.ref}"`) };
      const ref = matchRef(snap.labels, c.ref, false);
      if (ref === null) return { ok: false, said: `${wanted(`"${c.ref}"`)}, but nothing on the page is called that` };
      el = { ref, label: snap.labels.get(ref)! };
      found.set(c, el);
    }
    let st: ElState;
    try {
      st = await this.askRef<ElState>(PROBE_MS, 'state', el.ref);
    } catch (e) {
      if (e instanceof NoAnswer) return { ok: null, said: so(el.label) };
      st = { error: (e as Error).message } as ElState;
    }
    if (st.error) {
      found.delete(c);
      return { ok: false, said: `${wanted(el.label)}, but ${st.error}` };
    }
    if (c.kind === 'value') return valueVerdict(c.text, el.label, st);
    const not = (b: boolean | null) => (b === null ? null : !b);
    const is: Record<State, boolean | null> = {
      checked: st.checked,
      unchecked: not(st.checked),
      enabled: !st.disabled,
      disabled: st.disabled,
      focused: st.focused,
      expanded: st.expanded,
      collapsed: not(st.expanded),
      selected: st.selected,
      pressed: st.pressed,
    };
    if (is[c.state]) return { ok: true, said: so(el.label) };
    let but: string;
    if (c.state === 'focused') but = st.activeText ? `the focus is on ${this.focusLabel(client, el.ref, st)}` : 'nothing has the focus';
    else if (c.state === 'enabled' || c.state === 'disabled') but = `it's ${st.disabled ? 'disabled' : 'enabled'}`;
    else if (c.state === 'checked' || c.state === 'unchecked') but = st.checked === null ? "it isn't a checkbox or a radio button" : `it's ${st.checked ? 'checked' : 'unchecked'}`;
    else if (c.state === 'expanded' || c.state === 'collapsed') but = st.expanded === null ? "it doesn't say whether it's open (it has no aria-expanded)" : `it's ${st.expanded ? 'expanded' : 'collapsed'}`;
    else but = is[c.state] === null ? `it doesn't say (it has no aria-${c.state})` : "it isn't";
    return { ok: false, said: `${wanted(el.label)}, but ${but}` };
  }

  /** What has the focus in place of `ref`: as this client's snapshot shows it, or as it looks on the page. */
  private focusLabel(client: string, ref: number, st: ElState): string {
    const key = this.refs?.map.resolve(ref)?.key ?? TOP;
    const at = st.active === null ? undefined : this.refs?.map.lookup(key, st.active);
    return (at === undefined ? undefined : this.baselines.get(client)?.labels.get(at)) ?? st.activeText;
  }

  /** That nothing went wrong since the page loaded: the errors it logged and its own requests that failed, as notes tell them. */
  private errorsVerdict(): Verdict {
    const notes = this.problemNotes(0);
    if (notes.length) return { ok: false, said: `expected no errors, but ${notes.join('; ')}` };
    return { ok: true, said: 'the page logged no errors, and none of its own requests failed' };
  }

  async select(client: string, ref: number, option: string): Promise<string> {
    await this.checkRefs(client);
    const field = this.label(client, ref);
    let chosen = option;
    const action = async () => {
      const r = await this.callRef<{ text?: string; error?: string }>('select', ref, option);
      if (r.error) throw new Error(r.error);
      chosen = r.text!;
    };
    return this.act(client, () => `selected "${chosen}" in ${field}`, action);
  }

  press(client: string, key: string): Promise<string> {
    const k = parseKey(key); // validate before touching the page
    return this.act(client, `pressed ${key}`, () => this.page.press(k));
  }

  async scroll(client: string, to: string): Promise<string> {
    if (/^\d+$/.test(to)) {
      const ref = Number(to);
      await this.checkRefs(client);
      return this.act(client, `scrolled to ${this.label(client, ref)}`, async () => {
        await this.revealFrame(this.target(ref).frame);
        const r = await this.callRef<{ error?: string }>('scrollIntoView', ref);
        if (r.error) throw new Error(r.error);
      }, { showScroll: true });
    }
    const step = Math.round(this.page.height * 0.8);
    const actions: Record<string, () => Promise<unknown>> = {
      down: () => this.page.wheel(step),
      up: () => this.page.wheel(-step),
      top: () => this.call('scrollToEnd', 'top'),
      bottom: () => this.call('scrollToEnd', 'bottom'),
    };
    const action = actions[to];
    if (!action) throw new Error(`scroll where? use down, up, top, bottom, or a ref`);
    return this.act(client, `scrolled ${to}`, action, { showScroll: true });
  }

  /** Reload the page; with `diff`, report what changed from before (for a page being edited) rather than all of it. */
  reload(client: string, hard = false, diff = false): Promise<string> {
    if (this.dialog) this.answerQuietly();
    const reload = async () => {
      if (await this.page.unstick()) this.notes.push(UNSTUCK);
      await this.page.reload(hard);
    };
    return this.act(client, hard ? 'reloaded, bypassing the cache' : 'reloaded', reload, { across: diff });
  }

  /** Give a file field these files (absolute paths on this machine), as if they were picked in its dialog. */
  async upload(client: string, ref: number, files: string[]): Promise<string> {
    await this.checkRefs(client);
    const names = files.map((f) => basename(f)).join(', ');
    const what = `chose ${files.length === 1 ? names : `${files.length} files (${names})`} for ${this.label(client, ref)}`;
    return this.act(client, what, async () => {
      const r = await this.callRef<{ error?: string }>('fileField', ref, files.length);
      if (r.error) throw new Error(r.error);
      const { frame, local } = this.target(ref);
      await this.page.setFiles(`(${ACTIONS}).element(${local})`, files, frame);
    });
  }

  history(client: string, delta: -1 | 1): Promise<string> {
    const what = delta < 0 ? 'went back' : 'went forward';
    return this.act(client, what, async () => {
      if (await this.page.unstick()) this.notes.push(UNSTUCK);
      if (!(await this.page.history(delta))) throw new Error(`there is no page to go ${delta < 0 ? 'back' : 'forward'} to`);
    });
  }

  /** This tab's history, oldest first, numbered for `historyGo`. */
  async historyList(): Promise<{ current: number; entries: { url: string; title: string }[] }> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const { entries, currentId } = await this.visibleHistory();
    return {
      current: entries.findIndex((e) => e.id === currentId) + 1,
      entries: entries.map(({ url, title }) => ({ url, title })),
    };
  }

  /** This tab's history without the blank page every new tab starts on. */
  private async visibleHistory() {
    const { current, entries } = await this.page.historyEntries();
    return { currentId: entries[current]?.id, entries: entries.filter((e) => e.url !== 'about:blank') };
  }

  async historyText(): Promise<string> {
    const { current, entries } = await this.historyList();
    return entries
      .map((e, i) => `${i + 1}. ${e.title || '(untitled)'} · ${e.url}${i + 1 === current ? '  ← current' : ''}`)
      .join('\n');
  }

  /** Go to the n-th page of this tab's history (as numbered by historyList). */
  async historyGo(client: string, n: number): Promise<string> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const { currentId, entries } = await this.visibleHistory();
    const entry = entries[n - 1];
    if (!entry) throw new Error(`there is no page ${n} in this tab's history; history lists ${entries.length}`);
    if (entry.id === currentId) return this.report(client, `already on page ${n} of the history`);
    return this.act(client, `went to page ${n} of the history`, async () => {
      if (await this.page.unstick()) this.notes.push(UNSTUCK);
      await this.page.historyGo(entry.id);
    });
  }

  /** Let the page work; with `diff`, report what changed even if it loaded anew meanwhile (a dev server's reload). */
  wait(client: string, seconds: number, diff = false): Promise<string> {
    return this.act(client, `waited ${seconds}s`, () => sleep(seconds * 1000), { across: diff });
  }

  answer(client: string, accept: boolean, text?: string): Promise<string> {
    const d = this.dialog;
    if (!d) throw new Error('no dialog is open');
    this.dialog = null;
    const what = `${accept ? 'accepted' : 'dismissed'} the ${d.type} "${d.message}"`;
    return this.act(client, what, () => this.page.handleDialog(accept, text));
  }

  /**
   * The page's pictures as one image, for the terminal UI: a half-scale JPEG
   * (quality 70), or as asked. Everything but the pictures is hidden while it's taken, so
   * text laid over an image (a hero banner) comes out as text, not as pixels
   * of text, and a dialog over a picture doesn't cover it.
   */
  async pictures({ scale = 0.5, png = false, quality = 70 } = {}): Promise<Screenshot> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    // Pictures the browser loads only when scrolled near (loading="lazy", most
    // of a news page's) would come out as empty boxes: load them now, waiting
    // up to 4 seconds.
    await this.page.evaluate(`(async () => {
      const waits = [];
      for (const img of document.images) {
        if (img.loading === 'lazy') img.loading = 'eager';
        if (!img.complete) waits.push(new Promise((done) => {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }));
      }
      await Promise.race([Promise.all(waits), new Promise((done) => setTimeout(done, 4000))]);
    })()`).catch(() => {});
    const { cssContentSize } = await this.page.send('Page.getLayoutMetrics');
    const width = Math.ceil(cssContentSize.width);
    const height = Math.min(Math.ceil(cssContentSize.height), 16000);
    // Elements with a CSS background picture or gradient stay visible too,
    // with their own text made transparent.
    await this.page.evaluate(`(() => {
      for (const el of document.body ? document.body.querySelectorAll('*') : []) {
        if (getComputedStyle(el).backgroundImage !== 'none') el.setAttribute('data-medley-picture', '');
      }
      const s = document.createElement('style');
      s.id = '__medley_pictures';
      s.textContent = 'body * { visibility: hidden !important; transition: none !important; }' +
        ' img, video, canvas, svg[role=img], svg[role=img] * { visibility: visible !important; }' +
        ' [data-medley-picture] { visibility: visible !important; color: transparent !important; text-shadow: none !important; }';
      document.documentElement.appendChild(s);
    })()`);
    try {
      const shot = await this.page.send('Page.captureScreenshot', {
        ...(png ? { format: 'png' } : { format: 'jpeg', quality }),
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale },
      });
      return { image: shot.data, width, height, scale };
    } finally {
      await this.page.evaluate(`(() => {
        document.getElementById('__medley_pictures')?.remove();
        for (const el of document.querySelectorAll('[data-medley-picture]')) el.removeAttribute('data-medley-picture');
      })()`);
    }
  }

  /**
   * A PNG of the page as it looks: what's in the window, or with `full` the
   * whole page (up to 16,000 pixels tall). For what text can't show: charts,
   * canvas apps, how a layout looks.
   */
  async screenshot({ full = false } = {}): Promise<{ png: string; width: number; height: number; url: string }> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    let width = this.page.width;
    let height = this.page.height;
    let options = {};
    if (full) {
      const { cssContentSize } = await this.page.send('Page.getLayoutMetrics');
      width = Math.ceil(cssContentSize.width);
      height = Math.min(Math.ceil(cssContentSize.height), 16000);
      options = { captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } };
    }
    const shot = await this.page.send('Page.captureScreenshot', { format: 'png', ...options });
    const url = await this.page.evaluate<string>('location.href').catch(() => '');
    return { png: shot.data, width, height, url };
  }

  async hover(client: string, ref: number): Promise<string> {
    await this.checkRefs(client);
    return this.act(client, `hovered over ${this.label(client, ref)}`, async () => {
      const at = await this.locate(ref);
      await this.page.hover(at.x, at.y);
    });
  }

  // ---- finding things, and naming them -----------------------------------------------

  /**
   * The lines of the page that have `text` (in any case), each with a line
   * around it and where it is on the page, as diff hunks are labelled. The
   * refs in them work as usual.
   */
  async find(client: string, text: string, { context = 1 } = {}): Promise<string> {
    const want = text.trim().toLowerCase();
    if (!want) throw new Error('find needs some text to look for');
    if (this.dialog) return this.dialogText();
    await this.ensureTab();
    const snap = await this.capture();
    this.baselines.set(client, snap);
    const hits = snap.body.flatMap((l, i) => (l.toLowerCase().includes(want) ? [i] : []));
    const head = [...this.takeNotes(), ...snap.header, ''];
    if (!hits.length) return [...head, `find "${text}": no line has it (the page has ${snap.body.length} lines)`].join('\n');
    const groups: [number, number, number][] = []; // start, end, first hit
    for (const i of hits) {
      const start = Math.max(0, i - context);
      const end = Math.min(snap.body.length, i + context + 1);
      const last = groups[groups.length - 1];
      if (last && start <= last[1]) last[1] = end;
      else groups.push([start, end, i]);
    }
    const hit = new Set(hits);
    const out = [...head, `find "${text}": ${hits.length} of the page's ${snap.body.length} lines (> marks them)`];
    for (const [start, end, first] of groups.slice(0, 40)) {
      const where = whereIs(snap.body, first);
      out.push(where ? `@@ ${where} @@` : '@@');
      for (let i = start; i < end; i++) out.push(`${hit.has(i) ? '>' : ' '} ${snap.body[i]}`);
    }
    if (groups.length > 40) out.push(`… and ${groups.length - 40} more places; look for something more particular`);
    return out.join('\n');
  }

  /**
   * A ref from its number, or from the element's name as snapshots show it:
   * "Add to cart", or "button Add to cart" to say which kind. Names are looked
   * up on the page as the client last saw it, then as it is now, so they keep
   * working after the numbers have moved on. A name that fits several
   * elements is an error listing them, never a guess.
   */
  async resolveRef(client: string, value: unknown): Promise<number> {
    const raw = String(value ?? '').trim();
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n < 1) throw new Error(`"${raw}" is not a ref; refs are the numbers in a snapshot`);
      return n;
    }
    if (!raw) throw new Error('which element? give its ref, or its name');
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const doc = await this.call<string | null>('doc');
    const seen = this.baselines.get(client);
    if (seen && seen.doc === doc) {
      const ref = matchRef(seen.labels, raw, false);
      if (ref !== null) return ref;
    }
    const snap = await this.capture();
    this.baselines.set(client, snap);
    return matchRef(snap.labels, raw, true)!;
  }

  /**
   * A result over `max` characters: what happened (its first line and any
   * notes), then the page's outline in place of the page, saying so.
   */
  limit(client: string, text: string, max: number): string {
    if (!max || text.length <= max) return text;
    const snap = this.baselines.get(client);
    const kb = (n: number) => `${Math.round(n / 1000)} KB`;
    const note = `the result is ${kb(text.length)}, over your limit of ${kb(max)}, so here is the page's outline instead: read a part with section, look for something with find, or read an article's main text with reader`;
    if (!snap) return `${text.slice(0, max)}\n[cut at ${max} characters]`;
    const lines = text.split('\n');
    const lead = [lines[0], ...lines.filter((l) => l.startsWith('note: '))].filter((l) => l && l !== snap.header[0]);
    const out = [...new Set(lead), note, '', outlineText(snap)].join('\n');
    return out.length > max ? `${out.slice(0, max)}\n[cut at ${max} characters]` : out;
  }

  // ---- data --------------------------------------------------------------------

  /**
   * The page's tables and runs of repeated items, listed; or one of them as
   * data: a table as JSON rows (objects keyed by its header) or CSV, a run of
   * items as JSON (each with its text, its link's ref, words and address).
   */
  async extractData(client: string, { kind = '', n = 0, csv = false } = {}): Promise<string> {
    if (this.dialog) return this.dialogText();
    await this.ensureTab();
    const snap = await this.capture();
    this.baselines.set(client, snap);
    const data = pageData(this.lastModel!);
    if (!kind) return dataList(snap, data);
    if (kind === 'table') {
      const t = data.tables[n - 1];
      if (!t) throw new Error(`there is no table ${n}; the page has ${data.tables.length}`);
      if (csv) return [t.header, ...t.rows].filter((r): r is string[] => !!r).map(csvRow).join('\n');
      const rows = t.header ? t.rows.map((r) => Object.fromEntries(t.header!.map((h, i) => [h || `column ${i + 1}`, r[i] ?? '']))) : t.rows;
      return JSON.stringify(rows, null, 1);
    }
    if (kind === 'items') {
      const l = data.lists[n - 1];
      if (!l) throw new Error(`there is no list of items ${n}; the page has ${data.lists.length}`);
      if (csv) return [['text', 'ref', 'link', 'href'], ...l.items.map((i) => [i.text, String(i.ref ?? ''), i.link ?? '', i.href ?? ''])].map(csvRow).join('\n');
      return JSON.stringify(l.items, null, 1);
    }
    throw new Error(`extract table <n> or extract items <n>, not "${kind}"`);
  }

  // ---- the console and the network -----------------------------------------------

  /** What the page logged: errors and warnings (all of it with `all`), newest last. */
  async consoleText({ all = false } = {}): Promise<string> {
    await this.ensureTab();
    await this.hearConsole();
    const entries = this.page.console;
    const shown = entries.filter((e) => all || e.level === 'error' || e.level === 'warning');
    const errors = entries.filter((e) => e.level === 'error').length;
    const warnings = entries.filter((e) => e.level === 'warning').length;
    const head = `console: ${plural(errors, 'error')}, ${plural(warnings, 'warning')} (${plural(entries.length, 'message')} since the page loaded)`;
    const lines = shown.slice(-100).map((e) => `${e.level.padEnd(7)}  ${e.text}${e.where ? `  · ${shortWhere(e.where)}` : ''}`);
    const more = shown.length > 100 ? [`… ${shown.length - 100} earlier ones left out`] : [];
    const hint = !all && entries.length > shown.length ? ['(--all for every message)'] : [];
    return [head, ...more, ...lines, ...hint].join('\n');
  }

  /** Listen to the page's console, if nothing was yet (see Page.watchConsole). */
  private async hearConsole() {
    const fresh = !this.page.watchingConsole;
    await this.page.watchConsole();
    if (fresh) await sleep(200); // what the browser kept from before arrives now
  }

  /** The page's requests that failed (every request with `all`), in the order they were made. */
  async networkText({ all = false } = {}): Promise<string> {
    await this.ensureTab();
    const requests = [...this.page.requests.values()];
    const failed = requests.filter(requestFailed);
    const shown = all ? requests : failed;
    const head = `network: ${plural(requests.length, 'request')}, ${failed.length} failed`;
    const lines = shown.slice(-200).map((r) => {
      const how = failure(r);
      return `${how.padEnd(4)}  ${r.method} ${r.url.length > 160 ? r.url.slice(0, 159) + '…' : r.url}  (${r.type})`;
    });
    const more = shown.length > 200 ? [`… ${shown.length - 200} earlier ones left out`] : [];
    return [head, ...more, ...lines, ...(!all && requests.length ? ['(--all for every request)'] : [])].join('\n');
  }

  /**
   * Notes on what went wrong while an action ran (since `since`): errors the
   * page logged, and its own site's requests for pages, scripts and data that
   * failed. Other sites' (ads, trackers) are left to `network`.
   */
  private problemNotes(since: number): string[] {
    const notes: string[] = [];
    const errors = this.page.console.filter((e) => e.at >= since && e.level === 'error');
    if (errors.length) {
      const first = errors[0].text.length > 140 ? errors[0].text.slice(0, 139) + '…' : errors[0].text;
      notes.push(`the page logged ${plural(errors.length, 'error')}: ${first}${errors.length > 1 ? ' …' : ''} (console shows them)`);
    }
    const site = siteOf(hostOf(this.page.document?.url ?? ''));
    const failed = [...this.page.requests.values()].filter(
      (r) => r.at >= since && requestFailed(r) && /^(Document|Script|Stylesheet|XHR|Fetch)$/.test(r.type) && siteOf(hostOf(r.url)) === site,
    );
    if (failed.length) {
      const list = failed.slice(0, 3).map((r) => `${failure(r)} ${r.method} ${pathOf(r.url)}`);
      notes.push(`${plural(failed.length, 'request')} failed: ${list.join(', ')}${failed.length > 3 ? ', …' : ''} (network shows them)`);
    }
    return notes;
  }

  // ---- accessibility -----------------------------------------------------------------

  /**
   * An accessibility check of the page (see audit.js and audit.ts): what's
   * wrong, with the refs of what it's wrong with, as this client now sees
   * them; with `json`, the findings as data.
   */
  async audit(client: string, { json = false } = {}): Promise<string> {
    if (this.dialog) return this.dialogText();
    await this.ensureTab();
    const snap = await this.capture(); // numbers the refs the findings name
    this.baselines.set(client, snap);
    const result = await this.page.evaluate<AuditResult>(AUDIT);
    const global = (local: number) => this.refs?.map.lookup(TOP, local) ?? local;
    const labelOf = (local: number) => snap.labels.get(global(local));
    if (!json) return auditText(result, labelOf);
    const findings = result.findings.map(({ ref, ...f }) => {
      const label = ref === undefined ? undefined : labelOf(ref);
      return label ? { ...f, ref: global(ref!), label } : f;
    });
    return JSON.stringify({ ...result, findings }, null, 1);
  }

  // ---- one element, looked at closely ---------------------------------------------------

  /**
   * What a developer would look up about an element (see inspect.js and
   * inspect.ts): its markup and where it sits, its name and role, its box,
   * whether it can be seen and clicked (and why not), the styles it ends up
   * with, the CSS rules behind them and the event listeners that hear it,
   * each with where it's written. `css` names more properties to read. With
   * `shot`, a picture of just the element comes too, and the result is JSON
   * ({ text, png, width, height }). Nothing on the page is changed or
   * scrolled.
   */
  async inspect(client: string, ref: number, { json = false, shot = false, css = [] as string[] } = {}): Promise<string> {
    await this.checkRefs(client);
    const { frame } = this.target(ref);
    const found = await this.evalRef<Found>(ref, (local) => `${INSPECT}(${local}, ${JSON.stringify(css)})`);
    if (found.error) throw new Error(found.error);
    const { window: _own, pointer, error: _none, ...rest } = found;
    const notes: string[] = [];

    // Where it is in the page's own window: a frame from another site knows only its own.
    let win = found.window;
    let { x, y } = found.box;
    if (frame) {
      for (const f of this.page.frameChain(frame)) {
        const at = await this.page.evaluateIn<{ x: number; y: number; error?: string }>(this.page.parentOf(f), `(${ACTIONS}).frameBox(${JSON.stringify(f)}, false)`);
        if (at.error) throw new Error(at.error);
        x += at.x;
        y += at.y;
      }
      win = await this.page.evaluate<Found['window']>('({ w: innerWidth, h: innerHeight, sx: Math.round(scrollX), sy: Math.round(scrollY) })');
    }
    const { w, h } = found.box;
    const round = (n: number) => Math.round(n * 10) / 10;
    const box = { x: round(x + win.sx), y: round(y + win.sy), w, h };
    const out = [y + h <= 0 && 'above', y >= win.h && 'below', x + w <= 0 && 'left of', x >= win.w && 'right of'].filter(Boolean);
    const whole = x >= 0 && y >= 0 && x + w <= win.w && y + h <= win.h;
    const place = out.length ? `${out.join(' and ')} the window` : whole ? 'in the window' : 'partly in the window';

    const st = await this.callRef<ElState>('state', ref);
    if (st.error) throw new Error(st.error);
    const flag = (on: boolean | null, yes: string, no = '') => (on === null ? [] : on ? [yes] : no ? [no] : []);
    const states = [
      ...flag(st.checked, 'checked', 'unchecked'),
      ...flag(st.selected, 'selected'),
      ...flag(st.pressed, 'pressed'),
      ...flag(st.expanded, 'expanded', 'collapsed'),
      ...flag(st.disabled, 'disabled'),
      ...flag(st.focused, 'focused'),
    ];

    // Whether a click would land on it, as things are: nothing is scrolled to find out.
    let clickable = 'yes';
    if (found.hidden) clickable = "no: it can't be seen";
    else if (st.disabled) clickable = "no: it's disabled";
    else if (pointer) clickable = 'no: pointer-events is none, so clicks go through it to what is behind';
    else {
      try {
        await this.locate(ref, false);
      } catch (e) {
        const why = (e instanceof Covered ? this.coveredError(client, e) : (e as Error)).message.replace(/^ref \d+ /, '');
        clickable = /^isn't on screen/.test(why) ? "not where it is: it's outside the window (click scrolls to it first)" : `no: it ${why}`;
      }
    }

    const label = this.label(client, ref);
    const inspection: Inspection = {
      ref,
      label,
      ...rest,
      frame: !!frame,
      box,
      ...(st.value === null ? {} : { value: st.secret ? (st.value ? '********' : '') : st.value }),
      states,
      place,
      visible: found.hidden ? `no: ${found.hidden}` : 'yes',
      clickable,
      notes,
    };

    // What the page's script can't see: the browser is asked, about the nodes inspect.js left for it.
    try {
      inspection.rules = await this.page.rulesOf('window.__medleyInspect.el', frame);
    } catch (e) {
      notes.push(`its CSS rules couldn't be read: ${(e as Error).message}`);
    }
    try {
      const around = ['', ...[...found.path].reverse(), 'html', 'the document', 'the window'];
      const heard = await this.page.listenersOf('window.__medleyInspect.nodes', frame);
      inspection.listeners = heard.map((l) => ({ ...l, on: around[l.depth] ?? 'something around it' }));
    } catch (e) {
      notes.push(`its event listeners couldn't be read: ${(e as Error).message}`);
    }
    await this.page.evaluateIn(frame, 'delete window.__medleyInspect').catch(() => {});

    // A file and line, short. What's written in the page's own HTML (a <style>, an onclick) may have no file name to show.
    const short = (where: string) => shortWhere(where).replace(/^(?=:\d+$)/, '(this page)');
    const text = json ? JSON.stringify(inspection, null, 1) : inspectText(inspection, short);
    if (!shot) return text;
    if (found.hidden || w < 1 || h < 1) return JSON.stringify({ text: `${text}\nnote: no picture: there is nothing of it to see` });
    // Just the element, with a little of what's around it; small things at twice the size, to be legible.
    const pad = 8;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(w + 2 * pad, 2000),
      height: Math.min(h + 2 * pad, 2000),
      scale: Math.max(w, h) < 600 ? 2 : 1,
    };
    const picture = await this.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    return JSON.stringify({ text, png: picture.data, width: Math.round(clip.width * clip.scale), height: Math.round(clip.height * clip.scale) });
  }

  // ---- page info and source ---------------------------------------------------

  /** The connection, cookies and site data, what the page says about itself, and what loading it took (see info.ts). */
  async info(): Promise<PageInfo> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const about = await this.page.evaluate<About & { url: string; title: string; origin: string }>(
      `Object.assign(${ABOUT}, { url: location.href, title: document.title, origin: location.origin })`,
    );
    const url = new URL(about.url);
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    const site = web ? siteOf(url.host) : '';
    let cookies: PageInfo['cookies'] = null;
    let storage: PageInfo['storage'] = null;
    if (web) {
      // The cookies that go with the page's requests: its own site's, and those of the sites it asked for things.
      const urls = [about.url, ...about.hosts.slice(0, 100).map((h) => `https://${h}/`)];
      const { cookies: all } = await this.page.send('Network.getCookies', { urls }).catch(() => ({ cookies: [] }));
      const bySite = new Map<string, number>();
      for (const c of all as { domain: string }[]) {
        const s = siteOf(c.domain);
        bySite.set(s, (bySite.get(s) ?? 0) + 1);
      }
      const others = [...bySite].filter(([s]) => s !== site).map(([s, count]) => ({ site: s, count }));
      cookies = { site: bySite.get(site) ?? 0, others: others.sort((a, b) => b.count - a.count) };
      const used = await this.page.send('Storage.getUsageAndQuota', { origin: about.origin }).catch(() => null);
      if (used) {
        storage = {
          usage: used.usage,
          parts: (used.usageBreakdown ?? []).map((p: { storageType: string; usage: number }) => ({ type: p.storageType, usage: p.usage })),
        };
      }
    }
    // How the document arrived, if it's this one (not one a script put in place since).
    const doc = this.page.document;
    const response = doc && doc.url.split('#')[0] === about.url.split('#')[0] ? (({ requestId, ...arrived }) => arrived)(doc) : null;
    return {
      url: about.url,
      title: about.title,
      site,
      connection: { scheme: url.protocol, response },
      cookies,
      storage,
      about,
      problems: {
        heard: this.page.watchingConsole,
        errors: this.page.console.filter((e) => e.level === 'error').map((e) => e.text),
        warnings: this.page.console.filter((e) => e.level === 'warning').length,
        failed: [...this.page.requests.values()].filter(requestFailed).map((r) => `${failure(r)} ${r.method} ${r.url}`),
      },
    };
  }

  /** Delete the cookies and stored data (local storage, IndexedDB, caches…) of the page's site. */
  async clearSiteData(): Promise<string> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const { href, origin, host } = await this.page.evaluate<{ href: string; origin: string; host: string }>(
      '({ href: location.href, origin: location.origin, host: location.host })',
    );
    if (!/^https?:/.test(href)) throw new Error('only a web page has site data to clear');
    const site = siteOf(host);
    const { cookies } = await this.page.send('Network.getCookies', { urls: [href] });
    const mine = (cookies as { name: string; domain: string; path: string }[]).filter((c) => siteOf(c.domain) === site);
    for (const c of mine) await this.page.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
    const used = await this.page.send('Storage.getUsageAndQuota', { origin }).catch(() => ({ usage: 0 }));
    await this.page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    const stored = used.usage ? ` and ${Math.round(used.usage / 1000).toLocaleString('en-US')} kB of stored data` : '';
    return `cleared ${mine.length} ${mine.length === 1 ? 'cookie' : 'cookies'}${stored} for ${site}; reload to see the page without them`;
  }

  /**
   * The page's HTML: as the server sent it, or with `dom`, as the page is now
   * (after its scripts ran). Falls back to the latter when the browser no
   * longer has what was sent.
   */
  async source({ dom = false } = {}): Promise<{ text: string; what: string; url: string }> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const url = await this.page.evaluate<string>('location.href');
    const sent = !dom && this.page.document?.url.split('#')[0] === url.split('#')[0] ? await this.page.documentSource() : null;
    if (sent !== null) return { text: sent, what: 'as the server sent it', url };
    const now = await this.page.evaluate<string>(
      `(document.doctype ? '<!DOCTYPE ' + document.doctype.name + '>\\n' : '') + document.documentElement.outerHTML`,
    );
    return { text: now, what: dom ? 'as the page is now' : 'as the page is now (the browser no longer has what the server sent)', url };
  }

  // ---- tabs -----------------------------------------------------------------

  async tabList(): Promise<string> {
    return (await this.tabEntries())
      .map((t, i) => `${i + 1}. ${t.title || '(untitled)'} · ${t.url}${t.current ? '  ← current' : ''}`)
      .join('\n');
  }

  /** The open tabs, in order, with which one is current. */
  async tabEntries(): Promise<{ title: string; url: string; current: boolean }[]> {
    await this.ensureTab();
    const info = await this.browser.describe(this.tabs.map((t) => t.targetId));
    return this.tabs.map((t) => {
      const d = info.get(t.targetId);
      return { title: d?.title ?? '', url: d?.url ?? '', current: t === this.page };
    });
  }

  /** Open a new tab (on `url`, or blank) and carry on in it; the tab it came from is where closing it returns. */
  async newTab(client: string, url?: string): Promise<string> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const page = await this.browser.newPage();
    this.watch(page);
    this.tabs.push(page);
    this.openers.set(page, this.page);
    this.page = page;
    this.notes.push(`opened tab ${this.tabs.length}; now in that tab`);
    return url ? this.goto(client, url) : this.report(client, 'opened a new tab');
  }

  /** Open a link's address in a new tab (the page it's on stays as it is). */
  async openInNewTab(client: string, ref: number): Promise<string> {
    await this.checkRefs(client);
    const href = this.baselines.get(client)!.hrefs.find(([n]) => n === ref)?.[1];
    if (!href) throw new Error(`${this.label(client, ref)} isn't a link with an address; click it instead`);
    return this.newTab(client, href);
  }

  async switchTab(client: string, n: number): Promise<string> {
    if (this.dialog) throw new Error(this.dialogText());
    const page = this.tabs[n - 1];
    if (!page) throw new Error(`there is no tab ${n}; ${this.tabCount()}`);
    this.page = page;
    return this.report(client, `switched to tab ${n}`);
  }

  async closeTab(client: string, n?: number): Promise<string> {
    const i = n === undefined ? this.tabs.indexOf(this.page) : n - 1;
    const page = this.tabs[i];
    if (!page) throw new Error(`there is no tab ${n}; ${this.tabCount()}`);
    const current = page === this.page;
    this.tabClosed(page.targetId, true);
    await this.browser.closeTab(page.targetId).catch(() => {});
    if (!current) return `closed tab ${i + 1}; ${this.tabCount()}`;
    await this.ensureTab();
    return this.report(client, `closed tab ${i + 1}; now in tab ${this.tabs.indexOf(this.page) + 1}`);
  }

  /** What this session has downloaded, and where. */
  downloadList(): string {
    const running = this.browser.downloadProgress().map((d) => `  downloading ${d.name} (${progress(d.received, d.total)})`);
    if (!this.downloads.length && !running.length) return `nothing downloaded yet; downloads go to ${this.browser.downloadDir}`;
    const done = this.downloads.map((d, i) => `${i + 1}. ${d.name} · ${size(d.bytes)} · ${d.path}`);
    return [...done, ...running].join('\n');
  }

  private tabCount(): string {
    return this.tabs.length === 1 ? 'there is 1 tab' : `there are ${this.tabs.length} tabs`;
  }

  /**
   * A tab went away: we closed it, or its page did (window.close()). Carry on
   * in the tab that opened it, as a browser would, or else the one before it.
   */
  private tabClosed(targetId: string, quiet = false) {
    const i = this.tabs.findIndex((t) => t.targetId === targetId);
    if (i < 0) return; // not ours, or already handled
    const [page] = this.tabs.splice(i, 1);
    page.dispose();
    const opener = this.openers.get(page);
    this.openers.delete(page);
    if (page !== this.page) return;
    this.dialog = null; // it belonged to that tab
    const next = opener && this.tabs.includes(opener) ? opener : this.tabs[Math.max(0, i - 1)];
    if (!next) return; // ensureTab() opens a blank one
    this.page = next;
    if (!quiet) this.notes.push(`the tab closed; now in tab ${this.tabs.indexOf(next) + 1}`);
  }

  /** There's always a current tab, even after the last one closed. */
  private async ensureTab() {
    if (!this.page.closed) return;
    const page = await this.browser.newPage();
    this.watch(page);
    this.tabs.push(page);
    this.page = page;
  }

  /** The raw page model from extract.js, for debugging and tests. */
  model(): Promise<PageModel> {
    return this.page.evaluate<PageModel>(EXTRACT);
  }

  /** The page as this client last saw it (every command ends with a fresh look), and any open dialog. */
  view(client: string): View {
    const s = this.baselines.get(client);
    return {
      dialog: this.dialog,
      tabs: { current: this.tabs.indexOf(this.page) + 1, count: this.tabs.length },
      page: s
        ? {
            doc: s.doc,
            url: s.url,
            title: s.title,
            body: s.body,
            labels: [...s.labels],
            hrefs: s.hrefs,
            layout: s.layout,
            visual: s.visual,
          }
        : null,
    };
  }

  /** The refs as this client last saw them, by number, as snapshots show them ([8 button "Save"]). */
  labelsFor(client: string): Map<number, string> {
    return this.baselines.get(client)?.labels ?? new Map();
  }

  /** The current tab's address ('' while a dialog blocks it). */
  async currentUrl(): Promise<string> {
    if (this.dialog || this.page.closed) return '';
    return this.page.evaluate<string>('location.href').catch(() => '');
  }

  async status(): Promise<string> {
    const minutes = Math.round((Date.now() - this.startedAt) / 60000);
    if (this.dialog) return `a ${this.dialog.type} dialog is open · up ${minutes} min`;
    await this.ensureTab();
    const info =await this.page.evaluate<{ url: string; title: string }>('({ url: location.href, title: document.title })');
    return `${info.title || '(untitled)'} · ${info.url} · up ${minutes} min`;
  }

  // ---- machinery ----------------------------------------------------------

  private watch(page: Page) {
    page.onNavigated = () => {
      if (page === this.page && !this.acting) void this.pageChanged(page);
    };
    page.onDialog = (d) => {
      // Alerts only have an OK button, and leaving the page is what was asked
      // for; confirm() and prompt() are real choices, so they wait for an answer,
      // unless they come from a tab in the background, where nobody is looking.
      if (page !== this.page && d.type !== 'alert' && d.type !== 'beforeunload') {
        this.notes.push(`a background tab asked "${d.message}"; dismissed`);
        page.handleDialog(false).catch(() => {});
        return;
      }
      if (d.type === 'alert' || d.type === 'beforeunload') {
        this.notes.push(d.type === 'alert' ? `the page showed an alert: "${d.message}"` : 'the page asked before leaving; allowed');
        page.handleDialog(true).catch(() => {});
        return;
      }
      this.dialog = d;
      for (const wake of this.dialogWaiters) wake();
    };
  }

  private downloaded(e: DownloadEvent) {
    if (e.state === 'started') {
      this.downloadsStarted++;
      this.downloadsRunning.add(e.guid);
      return;
    }
    this.downloadsRunning.delete(e.guid);
    let news: string;
    if (e.state === 'done') {
      this.downloads.push({ name: e.name, path: e.path, bytes: e.bytes });
      news = `downloaded ${e.name} (${size(e.bytes)}) to ${e.path}`;
    } else {
      news = `the download of ${e.name} failed or was canceled`;
    }
    this.notes.push(news); // reported with the next result, whoever asks
    if (!this.acting) this.onNews?.('download', news);
  }

  /** Wait (up to `ms`) for running downloads; say how far any still-running one got. */
  private async downloadsFinish(ms: number) {
    const until = Date.now() + ms;
    while (this.downloadsRunning.size && Date.now() < until) await sleep(100);
    for (const d of this.browser.downloadProgress()) {
      this.notes.push(`still downloading ${d.name} (${progress(d.received, d.total)}); it will be noted when done`);
    }
  }

  /** The page navigated by itself: let it settle (it may redirect again), then say so, once. */
  private async pageChanged(page: Page) {
    if (this.changePending) return;
    this.changePending = true;
    try {
      await page.settle();
      if (page !== this.page || page.closed || this.acting || this.dialog) return;
      this.onNews?.('navigated', `the page loaded ${await page.evaluate<string>('location.href')} by itself`);
    } catch {
      // the tab closed or navigated again mid-look; a later navigation or command catches up
    } finally {
      this.changePending = false;
    }
  }

  /**
   * Run an action, let the page settle, and report what changed. A confirm()
   * or prompt() blocks the page (and the action with it), so if one opens the
   * result reports the dialog and the action finishes once it's answered.
   */
  private async act(
    client: string,
    what: string | (() => string),
    action: () => Promise<unknown>,
    outcome: Outcome = {},
  ): Promise<string> {
    if (this.dialog) throw new Error(this.dialogText());
    this.acting++;
    try {
      return await this.actNow(client, what, action, outcome);
    } finally {
      this.acting--;
    }
  }

  private async actNow(
    client: string,
    what: string | (() => string),
    action: () => Promise<unknown>,
    outcome: Outcome,
  ): Promise<string> {
    await this.ensureTab();
    let wake!: () => void;
    const dialogOpened = new Promise<'dialog'>((resolve) => {
      wake = () => resolve('dialog');
      this.dialogWaiters.add(wake);
    });
    const page = this.page;
    const since = Date.now(); // what went wrong from here on is this action's (see problemNotes)
    const downloadsBefore = this.downloadsStarted;
    const t0 = performance.now();
    const work = (async () => {
      await action();
      const t1 = performance.now();
      if (await page.settle()) {
        this.notes.push(`the page is still loading after ${SETTLE_S}s (a script or a request is holding it up): this is as far as it got`);
      }
      if (this.downloadsStarted > downloadsBefore) await this.downloadsFinish(30_000);
      this.timing.action = t1 - t0;
      this.timing.settle = performance.now() - t1;
    })();
    work.catch(() => {}); // if a dialog wins the race, this ends (or fails) in the background
    try {
      await Promise.race([work, dialogOpened]);
    } catch (e) {
      // Otherwise the action closed its own tab: report from the one we're in now.
      if (!page.closed) throw e instanceof Covered ? this.coveredError(client, e) : e;
    } finally {
      this.dialogWaiters.delete(wake);
    }
    if (!this.dialog) this.notes.push(...this.problemNotes(since));
    return this.report(client, typeof what === 'function' ? what() : what, outcome);
  }

  private async report(client: string, what: string, { full = false, showScroll = false, across = false }: Outcome = {}): Promise<string> {
    await this.ensureTab();
    await this.adoptPopup();
    const notes = this.takeNotes();
    if (this.dialog) return [what, ...notes, this.dialogText()].filter(Boolean).join('\n');

    const snap = await this.capture();
    const before = this.baselines.get(client);
    this.baselines.set(client, snap);
    if (full) return [...notes, fullText(snap)].join('\n');
    const anew = !!before && before.doc !== snap.doc;
    if (!before || (anew && !across)) return [`${what} → new page`, ...notes, '', fullText(snap)].join('\n');

    const facts = [...notes];
    if (snap.url !== before.url) facts.push(`url: ${snap.url}`);
    if (snap.title !== before.title) facts.push(`title: ${snap.title}`);
    if (showScroll) facts.push(/viewport .*$/.exec(snap.header[1])?.[0] ?? 'the page does not scroll');
    const d = diffLines(before.body, snap.body, 1, anew ? withoutRefs : undefined);
    if (!d || d.added + d.removed > MAX_CHURN * (before.body.length + snap.body.length)) {
      return [`${what} · page changed substantially`, ...facts, '', fullText(snap)].join('\n');
    }
    if (!d.added && !d.removed) return [`${what} · no visible change`, ...facts].join('\n');
    return [`${what} · +${d.added} -${d.removed} lines`, ...facts, d.text].join('\n');
  }

  private async capture(): Promise<Snap> {
    const t0 = performance.now();
    // A page stuck in a script can't be read: say so now, not after waiting out every read.
    if (!(await this.page.responsive())) throw new NoAnswer(STUCK);
    let model: PageModel;
    try {
      model = await this.extract();
    } catch (e) {
      if (e instanceof NoAnswer) throw e;
      // A navigation raced the snapshot; wait for it and try once more.
      await this.page.settle();
      model = await this.extract();
    }
    const r = renderParts(model);
    this.lastModel = model;
    this.timing.read = performance.now() - t0;
    return { doc: model.doc, url: model.url, title: model.title, ...r };
  }

  /** Where the last command's time went, for the log: "action 520 · settle 610 · read 95". */
  takeTiming(): string {
    const parts = Object.entries(this.timing).map(([k, ms]) => `${k} ${Math.round(ms)}`);
    this.timing = {};
    return parts.join(' · ');
  }

  /**
   * The page model, with the content of cross-origin frames (which the
   * page's own extraction can't reach) read separately and put in place of
   * their placeholders, and every ref given its page-wide number.
   */
  private async extract(): Promise<PageModel> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      await this.page.markFrames(null).catch(() => {});
      const model = await this.page.evaluate<PageModel>(EXTRACT);
      if (this.refs?.doc !== model.doc) this.refs = { doc: model.doc, map: new RefMap() };
      const map = this.refs.map;
      const frames = renumber(model.root, (ref) => map.global(TOP, ref), 0, 0);
      model.refs += await this.readFrames(frames, map, 1);
      // A frame that appeared a moment ago may not be marked or loaded yet: look
      // again, for a little while (a page with ads keeps adding frames).
      const settled = !this.page.framesSettling || !hasPlaceholder(model.root);
      if (attempt >= 2 || settled || Date.now() - started > 3000) return model;
      await sleep(400);
    }
  }

  /**
   * Read frames' content into their placeholders, all at once, then number
   * their refs in page order (so the numbers don't depend on which frame
   * answered first). Returns how many refs they have.
   */
  private async readFrames(nodes: El[], map: RefMap, depth: number): Promise<number> {
    if (depth > 4 || !nodes.length) return 0;
    const children = await Promise.all(nodes.map((node) => this.frameModel(node.frame!)));
    let refs = 0;
    for (const [i, node] of nodes.entries()) {
      const child = children[i];
      if (!child) continue; // still loading, or gone: the placeholder stays
      const key = `${node.frame}${KEY_SEP}${child.doc}`;
      // Its rects are in its own page's pixels; place them where the frame sits.
      const [x, y] = node.r ?? [0, 0];
      const inner = renumber(child.root, (ref) => map.global(key, ref), x, y - child.sy);
      refs += child.refs + (await this.readFrames(inner, map, depth + 1));
      const name = node.n;
      delete node.n;
      delete node.frame;
      Object.assign(node, { tag: 'div', d: 'b', lm: 'iframe', lmn: name, c: child.root!.c ?? [] });
    }
    return refs;
  }

  /**
   * A frame's page model, once it has its page (a cross-origin frame shows
   * about:blank until then). Null if it hasn't within 3 seconds, or is gone.
   */
  private async frameModel(frameId: string): Promise<PageModel | null> {
    const deadline = Date.now() + 3000;
    for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
      try {
        await this.page.markFrames(frameId).catch(() => {});
        const read = this.page.evaluateIn<PageModel>(frameId, EXTRACT);
        read.catch(() => {}); // it may answer after the deadline, or fail
        const child = await Promise.race([read, sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
        if (child?.root && child.url !== 'about:blank') return child;
      } catch {
        return null;
      }
      await sleep(250);
    }
    return null;
  }

  /**
   * Where a ref's element lives: a frame (null for the page itself), the
   * document it was numbered in there, and its number there.
   */
  private target(ref: number): { frame: string | null; doc: string; local: number } {
    const at = this.refs?.map.resolve(ref);
    if (!at || at.key === TOP) return { frame: null, doc: '', local: at?.local ?? ref };
    const cut = at.key.lastIndexOf(KEY_SEP);
    return { frame: at.key.slice(0, cut), doc: at.key.slice(cut + 1), local: at.local };
  }

  /**
   * Call a page action on a ref, in the frame its element is in. A frame
   * numbers its own elements, afresh for each page it loads; a ref from
   * before the frame loaded another page is refused rather than taken to
   * mean whatever has that number now. (The page's own refs are checked the
   * same way, before any action: see checkRefs.)
   */
  private callRef<T>(method: string, ref: number, ...args: unknown[]): Promise<T> {
    return this.askRef<T>(undefined, method, ref, ...args);
  }

  /** callRef, giving the page `timeout` ms to answer (NoAnswer if it doesn't). */
  private askRef<T>(timeout: number | undefined, method: string, ref: number, ...args: unknown[]): Promise<T> {
    return this.evalRef<T>(ref, (local) => `(${ACTIONS}).${method}(${[local, ...args].map((a) => JSON.stringify(a)).join(', ')})`, timeout);
  }

  /** Evaluate `code`, written for a ref's number in its own document, in the frame that document is in (see callRef). */
  private evalRef<T>(ref: number, code: (local: number) => string, timeout?: number): Promise<T> {
    const { frame, doc, local } = this.target(ref);
    const call = code(local);
    const stale = `the frame ref ${ref} was in has loaded another page since; take a new snapshot`;
    const expression = frame
      ? `((window.__medley && window.__medley.doc) === ${JSON.stringify(doc)} ? ${call} : { error: ${JSON.stringify(stale)} })`
      : call;
    return this.page.evaluateIn<T>(frame, expression, timeout);
  }

  /** Bring a frame (and any frames around it) into view, outermost first. */
  private async revealFrame(frame: string | null) {
    if (!frame) return;
    for (const f of this.page.frameChain(frame)) {
      const box = await this.page.evaluateIn<{ error?: string }>(this.page.parentOf(f), `(${ACTIONS}).frameBox(${JSON.stringify(f)}, true)`);
      if (box.error) throw new Error(box.error);
    }
  }

  /**
   * A point where a click lands on the ref's element, in the page's viewport.
   * In a frame: scroll the frame into view, find the point inside it, and add
   * where each enclosing frame's content starts.
   */
  private async locate(ref: number, scroll = true): Promise<{ x: number; y: number }> {
    const { frame } = this.target(ref);
    if (scroll) await this.revealFrame(frame);
    type Located = { x: number; y: number; error?: string; dialog?: number[] };
    const failed = (at: Located) => {
      if (!at.dialog) return new Error(at.error);
      const key = this.refs?.map.resolve(ref)?.key ?? TOP;
      const refs = at.dialog.map((local) => this.refs?.map.lookup(key, local) ?? local);
      return new Covered(at.error!, refs);
    };
    let at = await this.callRef<Located>('locate', ref, scroll);
    if (at.error) throw failed(at);
    if (frame && scroll) {
      // The browser places a frame's content where it was when it last drew;
      // after scrolling, let it draw before measuring (or a click lands where
      // the frame used to be).
      const drawn = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';
      await Promise.all([null, ...this.page.frameChain(frame)].map((f) => this.page.evaluateIn(f, drawn).catch(() => {})));
      await sleep(50);
      at = await this.callRef<Located>('locate', ref);
      if (at.error) throw failed(at);
    }
    let { x, y } = at;
    if (frame) {
      // Out through each frame to the page, checking that nothing in the
      // documents around the element (a banner over the frame) takes the click.
      for (const f of this.page.frameChain(frame).reverse()) {
        const parent = this.page.parentOf(f);
        const out = await this.page.evaluateIn<Located & { covered?: boolean }>(parent, `(${ACTIONS}).frameHit(${JSON.stringify(f)}, ${x}, ${y})`);
        if (out.error && !out.dialog) throw new Error(out.covered ? `ref ${ref} is ${out.error}` : out.error);
        if (out.error) {
          // A modal's buttons are numbered by the document it's in; the page's own are known here.
          const refs = parent === null ? (out.dialog ?? []).map((local) => this.refs?.map.lookup(TOP, local) ?? local) : [];
          throw new Covered(`ref ${ref} is ${out.error}`, refs);
        }
        x = out.x;
        y = out.y;
      }
    }
    return { x, y };
  }

  /** Refs only mean something against the document they came from. */
  private async checkRefs(client: string) {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const before = this.baselines.get(client);
    if (!before) throw new Error('take a snapshot first, so refs have something to point at');
    if ((await this.call<string | null>('doc')) !== before.doc) {
      throw new Error('the page has changed since your last snapshot; take a new one before using refs');
    }
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate<T>(`(${ACTIONS}).${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`);
  }

  /** Say how to close a modal in the way, naming its buttons the way this client's last snapshot showed them. */
  private coveredError(client: string, e: Covered): Error {
    const labels = this.baselines.get(client)?.labels;
    const known = e.refs.map((ref) => labels?.get(ref)).filter((l): l is string => !!l);
    if (!known.length) return new Error(`${e.message} (take a new snapshot to see it)`);
    return new Error(`${e.message}: ${known.slice(0, 3).join(', ')}${known.length > 3 ? ', …' : ''}`);
  }

  private label(client: string, ref: number): string {
    return this.baselines.get(client)?.labels.get(ref) ?? `[${ref}]`;
  }

  /** If the last action opened a new tab, carry on in that tab. */
  private async adoptPopup() {
    const targetId = this.browser.takePopup(this.page.targetId);
    if (!targetId) return;
    const page = await this.browser.attach(targetId);
    this.watch(page);
    this.tabs.push(page);
    this.openers.set(page, this.page);
    this.page = page;
    await page.settle();
    this.notes.push(`it opened a new tab (tab ${this.tabs.length}); now in that tab`);
  }

  private dialogText(): string {
    const d = this.dialog!;
    const prefill = d.type === 'prompt' && d.defaultPrompt ? ` (prefilled "${d.defaultPrompt}")` : '';
    const how = d.type === 'prompt' ? 'dialog accept [text] or dialog dismiss' : 'dialog accept or dialog dismiss';
    return `the page is showing a ${d.type} dialog: "${d.message}"${prefill}\nanswer it with ${how}`;
  }

  private answerQuietly() {
    this.page.handleDialog(false).catch(() => {});
    this.dialog = null;
  }

  private takeNotes(): string[] {
    return this.notes.splice(0).map((n) => `note: ${n}`);
  }
}
