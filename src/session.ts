// A long-lived browser session: one active page, actions addressed by the refs
// in its snapshots, and a baseline per client so each action reports only what
// changed since that client last looked.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep, type Dialog, type DownloadEvent, type LaunchOptions, type Page } from './browser.ts';
import { diffLines } from './diff.ts';
import { parseKey } from './keys.ts';
import { renderParts, type LayoutGroup, type PageModel, type Visual } from './render.ts';

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
  jpeg: string; // base64
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

/** 812 B, 1.2 kB, 3.4 MB */
function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

const progress = (received: number, total: number) => (total ? `${size(received)} of ${size(total)}` : `${size(received)} so far`);

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
  private acting = 0; // commands running now; a navigation they cause is theirs to report
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

  goto(client: string, url: string, { links = false } = {}): Promise<string> {
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
    return this.act(client, () => what, open, outcome).then((text) =>
      links ? `${text}\n\n── links ──\n${this.baselines.get(client)!.links.join('\n')}` : text,
    );
  }

  async snapshot(client: string, { diff = false, links = false } = {}): Promise<string> {
    if (this.dialog) return this.dialogText();
    await this.ensureTab();
    if (diff) return this.report(client, 'changes since your last look');
    const snap = await this.capture();
    this.baselines.set(client, snap);
    return [...this.takeNotes(), fullText(snap, links)].join('\n');
  }

  async click(client: string, ref: number): Promise<string> {
    await this.checkRefs(client);
    return this.act(client, `clicked ${this.label(client, ref)}`, async () => {
      const at = await this.call<{ x: number; y: number; error?: string }>('locate', ref);
      if (at.error) throw new Error(at.error);
      await this.page.click(at.x, at.y);
    });
  }

  async type(client: string, ref: number, text: string, submit = false): Promise<string> {
    await this.checkRefs(client);
    const what = `typed into ${this.label(client, ref)}${submit ? ' and pressed Enter' : ''}`;
    return this.act(client, what, async () => {
      const r = await this.call<{ hasText?: boolean; error?: string }>('focus', ref);
      if (r.error) throw new Error(r.error);
      if (text) await this.page.insertText(text);
      else if (r.hasText) await this.page.press(parseKey('Delete')); // clear the selected text
      if (submit) await this.page.press(parseKey('Enter'));
    });
  }

  async select(client: string, ref: number, option: string): Promise<string> {
    await this.checkRefs(client);
    const field = this.label(client, ref);
    let chosen = option;
    const action = async () => {
      const r = await this.call<{ text?: string; error?: string }>('select', ref, option);
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
        const r = await this.call<{ error?: string }>('scrollIntoView', ref);
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
      const r = await this.call<{ error?: string }>('fileField', ref, files.length);
      if (r.error) throw new Error(r.error);
      await this.page.setFiles(`(${ACTIONS}).element(${ref})`, files);
    });
  }

  history(client: string, delta: -1 | 1): Promise<string> {
    const what = delta < 0 ? 'went back' : 'went forward';
    return this.act(client, what, async () => {
      if (!(await this.page.history(delta))) throw new Error(`there is no page to go ${delta < 0 ? 'back' : 'forward'} to`);
    });
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
   * The page's pictures as one half-scale JPEG, for the terminal UI. Everything
   * but the pictures is hidden while it's taken, so text laid over an image
   * (a hero banner) comes out as text, not as pixels of text.
   */
  async screenshot(): Promise<Screenshot> {
    if (this.dialog) throw new Error(this.dialogText());
    await this.ensureTab();
    const { cssContentSize } = await this.page.send('Page.getLayoutMetrics');
    const width = Math.ceil(cssContentSize.width);
    const height = Math.min(Math.ceil(cssContentSize.height), 16000);
    const scale = 0.5;
    await this.page.evaluate(`(() => {
      const s = document.createElement('style');
      s.id = '__medley_pictures';
      s.textContent = 'body * { visibility: hidden !important; transition: none !important; }' +
        ' img, video, canvas, svg[role=img], svg[role=img] * { visibility: visible !important; }';
      document.documentElement.appendChild(s);
    })()`);
    try {
      const shot = await this.page.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 70,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale },
      });
      return { jpeg: shot.data, width, height, scale };
    } finally {
      await this.page.evaluate(`document.getElementById('__medley_pictures')?.remove()`);
    }
  }

  async hover(client: string, ref: number): Promise<string> {
    await this.checkRefs(client);
    return this.act(client, `hovered over ${this.label(client, ref)}`, async () => {
      const at = await this.call<{ x: number; y: number; error?: string }>('locate', ref);
      if (at.error) throw new Error(at.error);
      await this.page.hover(at.x, at.y);
    });
  }

  // ---- tabs -----------------------------------------------------------------

  async tabList(): Promise<string> {
    await this.ensureTab();
    const info = await this.browser.describe(this.tabs.map((t) => t.targetId));
    return this.tabs
      .map((t, i) => {
        const d = info.get(t.targetId);
        return `${i + 1}. ${d?.title || '(untitled)'} · ${d?.url ?? ''}${t === this.page ? '  ← current' : ''}`;
      })
      .join('\n');
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
    const work = (async () => {
      await action();
      await page.settle();
      if (this.downloadsStarted > downloadsBefore) await this.downloadsFinish(30_000);
    })();
    work.catch(() => {}); // if a dialog wins the race, this ends (or fails) in the background
    try {
      await Promise.race([work, dialogOpened]);
    } catch (e) {
      if (!page.closed) throw e; // otherwise the action closed its own tab: report from the one we're in now
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
    let model: PageModel;
    try {
      model = await this.page.evaluate<PageModel>(EXTRACT);
    } catch {
      // A navigation raced the snapshot; wait for it and try once more.
      await this.page.settle();
      model = await this.page.evaluate<PageModel>(EXTRACT);
    }
    const r = renderParts(model);
    return { doc: model.doc, url: model.url, title: model.title, ...r };
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
