// A long-lived browser session: one active page, actions addressed by the refs
// in its snapshots, and a baseline per client so each action reports only what
// changed since that client last looked.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep, type Dialog, type DownloadEvent, type LaunchOptions, type Page } from './browser.ts';
import { diffLines } from './diff.ts';
import { parseKey } from './keys.ts';
import { findTokens } from './tokens.ts';
import { renderParts, type El, type LayoutGroup, type PageModel, type Visual } from './render.ts';

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const EXTRACT = read('./extract.js');
const ACTIONS = read('./page-actions.js');

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

type Outcome = { full?: boolean; showScroll?: boolean };

/** What a client that draws the page itself (the terminal UI) needs after a command. */
export interface View {
  dialog: Dialog | null;
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

/** The regions and headings of a page, in order. */
function partsOf(body: string[]): Part[] {
  const parts: Part[] = [];
  body.forEach((text, line) => {
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

const refCount = (lines: string[]) => lines.reduce((n, l) => n + findTokens(l).length, 0);

/** The page as its regions and headings, each with how much it holds. */
function outlineText(s: Snap): string {
  const parts = partsOf(s.body);
  const refs = refCount(s.body);
  const lines = parts.map((p, i) => {
    const end = partEnd(parts, i, s.body.length);
    const inner = s.body.slice(p.line + 1, end);
    const own = refCount(inner);
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

  goto(client: string, url: string, { links = false, outline = false } = {}): Promise<string> {
    if (this.dialog) this.answerQuietly();
    const outcome: Outcome = { full: true };
    let what = `opened ${url}`;
    const open = async () => {
      const before = this.downloadsStarted;
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
      return links ? `${text}\n\n── links ──\n${snap.links.join('\n')}` : text;
    });
  }

  async snapshot(client: string, { diff = false, links = false, outline = false, section = '' } = {}): Promise<string> {
    if (this.dialog) return this.dialogText();
    await this.ensureTab();
    if (diff) return this.report(client, 'changes since your last look');
    const snap = await this.capture();
    this.baselines.set(client, snap);
    const page = section ? sectionText(snap, section) : outline ? outlineText(snap) : fullText(snap, links);
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
    const r = await this.callRef<{ hasText?: boolean; error?: string }>('focus', ref);
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
    // The page's title counts too: waiting for the next page is often waiting for its title.
    const probe = `(() => (document.title + '\\n' + ((document.body && document.body.innerText) || '')).toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))()`;
    let what = '';
    return this.act(client, () => what, async () => {
      const start = Date.now();
      for (;;) {
        let present = false;
        try {
          present = await this.page.evaluate<boolean>(probe);
        } catch {
          // the page is between documents; look again
        }
        const took = ((Date.now() - start) / 1000).toFixed(1);
        if (present !== gone) {
          what = gone ? `"${text}" went away after ${took}s` : `"${text}" appeared after ${took}s`;
          return;
        }
        if (Date.now() - start >= seconds * 1000) {
          what = gone ? `"${text}" was still there after ${seconds}s` : `"${text}" didn't appear within ${seconds}s`;
          return;
        }
        await sleep(250);
      }
    });
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

  reload(client: string, hard = false): Promise<string> {
    if (this.dialog) this.answerQuietly();
    return this.act(client, hard ? 'reloaded, bypassing the cache' : 'reloaded', () => this.page.reload(hard));
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
    return this.act(client, `went to page ${n} of the history`, () => this.page.historyGo(entry.id));
  }

  wait(client: string, seconds: number): Promise<string> {
    return this.act(client, `waited ${seconds}s`, () => sleep(seconds * 1000));
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
    page.closed = true;
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
    const downloadsBefore = this.downloadsStarted;
    const t0 = performance.now();
    const work = (async () => {
      await action();
      const t1 = performance.now();
      await page.settle();
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
    return this.report(client, typeof what === 'function' ? what() : what, outcome);
  }

  private async report(client: string, what: string, { full = false, showScroll = false }: Outcome = {}): Promise<string> {
    await this.ensureTab();
    await this.adoptPopup();
    const notes = this.takeNotes();
    if (this.dialog) return [what, ...notes, this.dialogText()].filter(Boolean).join('\n');

    const snap = await this.capture();
    const before = this.baselines.get(client);
    this.baselines.set(client, snap);
    if (full) return [...notes, fullText(snap)].join('\n');
    if (!before || before.doc !== snap.doc) return [`${what} → new page`, ...notes, '', fullText(snap)].join('\n');

    const facts = [...notes];
    if (snap.url !== before.url) facts.push(`url: ${snap.url}`);
    if (snap.title !== before.title) facts.push(`title: ${snap.title}`);
    if (showScroll) facts.push(/viewport .*$/.exec(snap.header[1])?.[0] ?? 'the page does not scroll');
    const d = diffLines(before.body, snap.body);
    if (!d || d.added + d.removed > MAX_CHURN * (before.body.length + snap.body.length)) {
      return [`${what} · page changed substantially`, ...facts, '', fullText(snap)].join('\n');
    }
    if (!d.added && !d.removed) return [`${what} · no visible change`, ...facts].join('\n');
    return [`${what} · +${d.added} -${d.removed} lines`, ...facts, d.text].join('\n');
  }

  private async capture(): Promise<Snap> {
    const t0 = performance.now();
    let model: PageModel;
    try {
      model = await this.extract();
    } catch {
      // A navigation raced the snapshot; wait for it and try once more.
      await this.page.settle();
      model = await this.extract();
    }
    const r = renderParts(model);
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

  /** Where a ref's element lives: a frame (null for the page itself) and its number there. */
  private target(ref: number): { frame: string | null; local: number } {
    const at = this.refs?.map.resolve(ref);
    if (!at || at.key === TOP) return { frame: null, local: at?.local ?? ref };
    return { frame: at.key.slice(0, at.key.lastIndexOf(KEY_SEP)), local: at.local };
  }

  /** Call a page action on a ref, in the frame its element is in. */
  private callRef<T>(method: string, ref: number, ...args: unknown[]): Promise<T> {
    const { frame, local } = this.target(ref);
    const expression = `(${ACTIONS}).${method}(${[local, ...args].map((a) => JSON.stringify(a)).join(', ')})`;
    return this.page.evaluateIn<T>(frame, expression);
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
      for (const f of this.page.frameChain(frame).reverse()) {
        const box = await this.page.evaluateIn<{ x: number; y: number; error?: string }>(
          this.page.parentOf(f),
          `(${ACTIONS}).frameBox(${JSON.stringify(f)}, false)`,
        );
        if (box.error) throw new Error(box.error);
        x += box.x;
        y += box.y;
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
