// The terminal UI: an address bar, the page, a status line, and a bottom row
// that shows key hints or an input prompt. It is one more client of the
// session, so it can watch an agent browse and take over at any point.

import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  NativeImage,
  TextAttributes,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
} from '@opentui/core';
import { STALE_HINT, type Reply, type SessionEvent } from '../client.ts';
import { resolve } from 'node:path';
import { addBookmark, readBookmarks, removeBookmark } from '../bookmarks.ts';
import { looksLikeAddress, parseCommand, searchUrl, splitFlags, splitWords, toUrl } from '../commands.ts';
import { changedLines } from '../diff.ts';
import type { Screenshot, View } from '../session.ts';
import { Bar, fit as fitText, type Segment } from './bar.ts';
import { GRID_LABELS, GRID_MODES, PageView, type PageRef } from './page-view.ts';
import { RefList, refItems, type RefItem } from './ref-list.ts';
import { Splash } from './splash.ts';
import { THEME } from './theme.ts';

/** How the UI reaches the session; a test can supply its own. */
export interface Backend {
  readonly client: string;
  request(cmd: string, args?: Record<string, unknown>, start?: boolean): Promise<Reply>;
  /** Follow other clients' commands; returns a function that stops following. */
  watch(onEvent: (e: SessionEvent) => void, onConnection: (connected: boolean) => void): () => void;
  /** Whether the session runs other (older) code than this UI, so it may not know newer commands. */
  stale?(): boolean;
  /** Start the session in the background, so it's ready when the first page is asked for. */
  prewarm?(): Promise<void>;
}

/** A line of the bookmarks-and-history list: a bookmark, or a page of this tab's history. */
type PickItem = { kind: 'bookmark'; n: number; title: string; url: string } | { kind: 'history'; n: number; title: string; url: string; current: boolean };

type PromptKind ='url' | 'field' | 'secret' | 'select' | 'file' | 'command' | 'find' | 'answer';
interface Prompt {
  kind: PromptKind;
  label: string;
  ref?: number;
}

// Shown in the status line while a prompt is open, since its keys differ from browsing.
const PROMPT_HINTS: Record<PromptKind, string> = {
  url: 'type a web address, like en.wikipedia.org, or words to search for · Enter · Esc cancels',
  field: 'Enter types and submits · Tab types only · Esc cancels',
  secret: 'what you type is hidden · Enter types and submits · Tab types only · Esc cancels',
  select: "type an option's text · Enter chooses it · Esc cancels",
  file: 'type file paths, quoting any with spaces · Enter chooses them · Esc cancels',
  command: 'e.g. press Escape, wait 2, scroll bottom · Enter runs it · Esc cancels',
  find: 'Enter finds · Esc cancels',
  answer: 'Enter answers · Esc dismisses the dialog',
};

type Tone = 'info' | 'ok' | 'warn' | 'error';
const TONE = { info: THEME.text, ok: THEME.ok, warn: THEME.warn, error: THEME.error };

const HINTS = 'Tab select · Enter open · l refs · o address · ← back · / find · v grid · ? keys · q quit';
const BADGE = ' medley ';
const BADGE_FRAME_MS = 90;
const BADGE_SWEEP = 2 * (BADGE.length - 1); // frames for the band to go across and back
const FIELD_KINDS = new Set(['textbox', 'password', 'combobox']);
const ACTIVITY_MS = 20_000; // how long another client's action stays in the status line

const HELP = [
  'Tab, Shift+Tab     select the next or previous ref',
  'Enter              open the selected ref: links and buttons are clicked,',
  '                   text fields, selects and file fields ask for input',
  '0-9, then Enter    open a ref by its number',
  'mouse click        open the ref under the pointer',
  'h                  hover over the selected ref (menus that open on hover)',
  '↑ ↓ j k            scroll a line; Home End: top, bottom',
  'Space PgDn PgUp    scroll a page (past the end loads more of the page)',
  '[ ]                previous or next tab (links can open new tabs)',
  'o, Ctrl+L          open an address',
  '← b, → f           back, forward',
  '/, then n N        find text, then the next or previous match',
  ':                  run a command: press Escape, wait 2, select 6 High, …',
  'l, or click N refs  the page’s refs in a list: type to filter, Enter opens',
  'v                  grid: none → partial (main columns) → advanced (nested too)',
  'a                  bookmark this page',
  "B                  bookmarks and this tab's history: a number, then Enter opens",
  'r, R               reload the page (R: bypassing the cache)',
  'w                  wait 2 seconds and show what the page changed by itself',
  'y n                accept or dismiss a dialog the page opened',
  'Esc                clear the selection and the search',
  'q                  quit; asks first, then whether to keep the browser session',
  'Q, Ctrl+C          quit at once, keeping the session running',
  '',
  'In a field prompt: Enter types and submits, Tab types only, Esc cancels.',
];

export class App {
  private page: PageView;
  private top: Bar;
  private status: Bar;
  private hints: Bar;
  private promptLabel: Bar;
  private input: InputRenderable;
  private help: BoxRenderable;
  private pages: BoxRenderable; // the bookmarks-and-history list (B)
  private pagesText: TextRenderable;
  private refsBox: BoxRenderable; // the refs pull-down (l, or a click on "N refs")
  private refList: RefList;
  private splash: Splash; // the logo, while there's no page yet
  private picker: { items: PickItem[]; digits: string } | null = null;

  private current: View['page'] = null;
  private dialog: View['dialog'] = null;
  private tabs: View['tabs'] = { current: 1, count: 1 };
  private busy = false;
  private prewarmed = false; // this UI started the session in the background (see start)
  private doing = ''; // what the running command is doing, for the status line
  private busySince = 0;
  private badgeTimer: ReturnType<typeof setInterval> | undefined;
  private badgeFrame = 0;
  private refreshQueued = false;
  private prompt: Prompt | null = null;
  private promptError = ''; // why the prompt's last input was refused
  private secret = ''; // what's typed into a password prompt; the input only shows dots
  private quitting: 'no' | 'confirm' | 'session' = 'no'; // which quit question is showing
  private stopped = false;
  private picturesFor: string | null = null; // the document whose screenshot was asked for
  private digits = '';
  private message: { text: string; tone: Tone } = { text: '', tone: 'info' };
  private activity = ''; // the latest thing another client did
  private activityTimer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;
  private stopWatching: () => void;
  private finish!: () => void;
  readonly closed = new Promise<void>((resolve) => (this.finish = resolve));

  constructor(
    private renderer: CliRenderer,
    private backend: Backend,
  ) {
    const root = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', height: '100%' });
    this.top = new Bar(renderer, {
      bg: THEME.barBg,
      // "N refs" is on the right: a click there pulls down the list of refs.
      onClick: (x, right) => {
        if (right >= 0 && x >= right) this.openRefs();
      },
    });
    this.page = new PageView(renderer, {
      flexGrow: 1,
      onActivate: (ref) => this.activate(ref),
      onScroll: () => this.drawTop(),
    });
    this.status = new Bar(renderer, {});
    const bottom = new BoxRenderable(renderer, { flexDirection: 'row', height: 1 });
    this.promptLabel = new Bar(renderer, { bg: THEME.barBg, visible: false });
    this.input = new InputRenderable(renderer, {
      flexGrow: 1,
      visible: false,
      backgroundColor: THEME.barBg,
      focusedBackgroundColor: THEME.barBg,
      textColor: THEME.barFg,
      cursorColor: THEME.accentBg,
    });
    this.hints = new Bar(renderer, { flexGrow: 1, bg: THEME.barBg, fg: THEME.barDim });
    bottom.add(this.promptLabel);
    bottom.add(this.input);
    bottom.add(this.hints);
    root.add(this.top);
    root.add(this.page);
    root.add(this.status);
    root.add(bottom);
    renderer.root.add(root);

    this.help = new BoxRenderable(renderer, {
      position: 'absolute',
      top: 2,
      left: 2,
      right: 2,
      height: HELP.length + 2,
      zIndex: 10,
      visible: false,
      border: true,
      borderStyle: 'rounded',
      borderColor: THEME.accentBg,
      title: ' keys · any key to close ',
      backgroundColor: THEME.barBg,
    });
    this.help.add(new TextRenderable(renderer, { content: HELP.join('\n'), fg: THEME.barFg, paddingLeft: 1 }));
    renderer.root.add(this.help);

    this.pages = new BoxRenderable(renderer, {
      position: 'absolute',
      top: 2,
      left: 2,
      right: 2,
      height: 5,
      zIndex: 10,
      visible: false,
      border: true,
      borderStyle: 'rounded',
      borderColor: THEME.accentBg,
      title: ' bookmarks and history · Esc to close ',
      backgroundColor: THEME.barBg,
    });
    this.pagesText = new TextRenderable(renderer, { content: '', fg: THEME.barFg, paddingLeft: 1 });
    this.pages.add(this.pagesText);
    renderer.root.add(this.pages);

    this.refsBox = new BoxRenderable(renderer, {
      position: 'absolute',
      top: 1,
      right: 1,
      width: 60,
      height: 10,
      zIndex: 11,
      visible: false,
      border: true,
      borderStyle: 'rounded',
      borderColor: THEME.accentBg,
      backgroundColor: THEME.barBg,
    });
    this.refList = new RefList(renderer, { width: '100%', height: '100%', onPick: (item) => this.pickRef(item) });
    this.refsBox.add(this.refList);
    renderer.root.add(this.refsBox);

    this.splash = new Splash(renderer, { position: 'absolute', top: 1, left: 0, right: 0, bottom: 2, zIndex: 5, visible: false });
    renderer.root.add(this.splash);

    renderer.keyInput.on('keypress', this.onKey);
    renderer.keyInput.on('paste', this.onPaste);
    this.input.on(InputRenderableEvents.ENTER, (value: string) => this.submitPrompt(value, true));
    this.stopWatching = backend.watch(
      (e) => this.onEvent(e),
      (connected) => {
        this.connected = connected;
        this.drawStatus();
      },
    );
    this.draw();
  }

  /** Open `url`, or else show the session's current page. */
  async start(url?: string) {
    if (url) await this.run('goto', { url }, { start: true });
    else if (!(await this.run('snapshot', {}, { quiet: true }))) {
      this.openPrompt({ kind: 'url', label: 'open' });
      // Start the browser while the address is typed; it takes a second or two.
      if (this.backend.prewarm) {
        this.prewarmed = true;
        void this.backend.prewarm();
      }
      return;
    }
    if (this.backend.stale?.()) this.say(`${STALE_HINT}: q, y, n, then start the UI again`, 'warn');
  }

  /** Whether this UI started a session in the background that never opened a page (to stop on quit). */
  get prewarmedUnused(): boolean {
    return this.prewarmed && !this.current && !this.stopped;
  }

  /** Whether a page from a running session is showing. */
  get attached(): boolean {
    return this.current !== null;
  }

  /** Whether quitting also stopped the browser session. */
  get stoppedSession(): boolean {
    return this.stopped;
  }

  quit() {
    clearTimeout(this.activityTimer);
    clearInterval(this.badgeTimer);
    this.splash.stop();
    this.stopWatching();
    this.renderer.keyInput.off('keypress', this.onKey);
    this.renderer.keyInput.off('paste', this.onPaste);
    this.finish();
  }

  // ---- talking to the session -------------------------------------------------

  private async run(cmd: string, args: Record<string, unknown> = {}, opts: { start?: boolean; quiet?: boolean } = {}) {
    if (this.busy) {
      this.say('still working on the last action', 'warn');
      return false;
    }
    this.busy = true;
    this.doing = opts.quiet ? '' : this.describeCommand(cmd, args);
    this.busySince = Date.now();
    this.animateBadge(true);
    this.drawStatus();
    try {
      const reply = await this.backend.request(cmd, args, opts.start);
      this.apply(cmd, reply, opts.quiet);
      return true;
    } catch (e) {
      const text = (e as Error).message;
      if (text.startsWith('no browser session')) {
        this.show({ dialog: null, page: null });
        this.say('no session is running; press o to open a page', 'warn');
      } else if (text.startsWith('unknown command')) {
        this.say(`${text}: ${STALE_HINT} (q, y, n, then start the UI again)`, 'error');
      } else {
        this.say(text.split('\n')[0], 'error');
        // Refs went stale under us (another client navigated); catch up.
        if (/since your last snapshot|isn't on the page/.test(text)) this.refreshQueued = true;
      }
      return false;
    } finally {
      this.busy = false;
      this.doing = '';
      this.animateBadge(false);
      this.draw();
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.run('snapshot', {}, { quiet: true });
      }
    }
  }

  private apply(cmd: string, reply: Reply, quiet = false) {
    if (reply.state) this.show(reply.state);
    if (quiet) return;
    const lines = reply.text.split('\n');
    const notes = lines.filter((l) => l.startsWith('note: ')).map((l) => l.slice(6));
    let summary = cmd === 'goto' ? '' : cmd === 'snapshot' ? 'refreshed' : lines[0];
    if (cmd === 'status' || cmd === 'stop' || cmd === 'downloads') summary = reply.text.replaceAll('\n', ' · ');
    // A download is the news when there is one: first, so a narrow status line keeps where it went.
    const download = (n: string) => /^(downloaded|still downloading|the download)/.test(n);
    this.say([...notes.filter(download), summary, ...notes.filter((n) => !download(n))].filter(Boolean).join(' · '), 'ok');
  }

  private show(view: View) {
    this.dialog = view.dialog;
    if (view.tabs) this.tabs = view.tabs;
    const page = view.page;
    if (!page) {
      this.current = null;
      this.page.setPage([], new Map(), new Set(), true);
    } else {
      const fresh = page.doc !== this.current?.doc;
      const changed = fresh ? new Set<number>() : changedLines(this.current!.body, page.body);
      this.current = page;
      this.page.setPage(page.body, new Map(page.labels), changed, fresh, page.layout, page.visual ?? null);
      if (fresh) this.picturesFor = null;
      if (this.refsBox.visible) this.refreshRefs(); // the page changed under the open list
      void this.loadPictures();
    }
    if (this.dialog?.type === 'prompt' && !this.prompt) {
      this.openPrompt({ kind: 'answer', label: `answer "${this.dialog.message}"` }, this.dialog.defaultPrompt ?? '');
    }
  }

  private onEvent(e: SessionEvent) {
    if (e.client === this.backend.client || ['snapshot', 'status', 'screenshot', 'tabs'].includes(e.cmd)) return;
    if (e.summary.startsWith('listed the ')) return; // history, downloads: nothing on the page changed
    const who = e.client.startsWith('mcp') ? 'agent' : e.client;
    this.activity = e.client === 'page' ? e.summary : `${who}: ${e.summary}`;
    clearTimeout(this.activityTimer);
    this.activityTimer = setTimeout(() => {
      this.activity = '';
      this.drawStatus();
    }, ACTIVITY_MS);
    this.drawStatus();
    if (!e.ok) return;
    if (this.busy) this.refreshQueued = true;
    else void this.run('snapshot', {}, { quiet: true });
  }

  // ---- acting on refs ---------------------------------------------------------

  private activate(ref: PageRef) {
    this.page.select(ref.ref);
    const label = `[${ref.ref}${ref.kind === 'link' ? '' : ` ${ref.kind}`}${ref.name ? ` "${ref.name}"` : ''}]`;
    if (ref.kind === 'password') {
      this.openPrompt({ kind: 'secret', ref: ref.ref, label: `type into ${label}` });
    } else if (FIELD_KINDS.has(ref.kind)) {
      const value = ref.value === '********' ? '' : (ref.value ?? '');
      this.openPrompt({ kind: 'field', ref: ref.ref, label: `type into ${label}` }, value);
    } else if (ref.kind === 'select') {
      this.openPrompt({ kind: 'select', ref: ref.ref, label: `choose in ${label}` }, ref.value ?? '');
    } else if (ref.kind === 'file') {
      this.openPrompt({ kind: 'file', ref: ref.ref, label: `choose files for ${label}` });
    } else {
      void this.run('click', { ref: ref.ref });
    }
  }

  private activateNumber(n: number) {
    const ref = this.page.hasRef(n);
    if (ref) this.activate(ref);
    else this.say(`there is no ref ${n} on this page`, 'error');
  }

  // ---- prompts ------------------------------------------------------------------

  private openPrompt(prompt: Prompt, initial = '', error = '') {
    this.prompt = prompt;
    this.promptError = error;
    const text = ` ${prompt.label} › `;
    this.promptLabel.set([{ text, fg: THEME.accentBg, attrs: TextAttributes.BOLD }]);
    this.promptLabel.width = Bun.stringWidth(text);
    this.promptLabel.visible = true;
    this.input.visible = true;
    this.hints.visible = false;
    this.secret = '';
    this.input.value = prompt.kind === 'secret' ? '' : initial;
    // A password prompt keeps its text itself (see secretKey); the input only shows dots.
    if (prompt.kind === 'secret') this.input.blur();
    else this.input.focus();
    this.draw();
  }

  private closePrompt() {
    this.prompt = null;
    this.secret = '';
    this.input.blur();
    this.input.visible = false;
    this.promptLabel.visible = false;
    this.hints.visible = true;
    this.draw();
  }

  /** `enter` is false when the prompt was left with Tab: fill a field without submitting it. */
  private submitPrompt(value: string, enter: boolean) {
    const prompt = this.prompt;
    if (!prompt) return;
    this.closePrompt();
    switch (prompt.kind) {
      case 'url': {
        const address = value.trim();
        if (!address) break;
        if (looksLikeAddress(address)) {
          void this.run('goto', { url: toUrl(address) }, { start: true });
        } else if ([...address].length < 2) {
          // Don't start a browser for a stray key (like a q meant to quit).
          this.openPrompt(prompt, value, `"${address}" isn't a web address or a search; type an address, or words to search for`);
        } else {
          void this.run('goto', { url: searchUrl(address), search: address }, { start: true });
        }
        break;
      }
      case 'field':
      case 'secret':
        void this.run('type', { ref: prompt.ref, text: value, submit: enter });
        break;
      case 'select':
        void this.run('select', { ref: prompt.ref, option: value });
        break;
      case 'file': {
        const files = splitWords(value).map((f) => resolve(f));
        if (files.length) void this.run('upload', { ref: prompt.ref, files });
        break;
      }
      case 'answer':
        void this.run('dialog', { action: 'accept', text: value });
        break;
      case 'find':
        this.find(value);
        break;
      case 'command':
        this.command(value);
        break;
    }
  }

  private cancelPrompt() {
    const prompt = this.prompt;
    this.closePrompt();
    if (prompt?.kind === 'answer') void this.run('dialog', { action: 'dismiss' });
  }

  private command(line: string) {
    try {
      const { words, flags } = splitFlags(splitWords(line));
      const { cmd, args, start } = parseCommand(words, flags);
      void this.run(cmd, args, { start });
    } catch (e) {
      this.say((e as Error).message, 'error');
    }
  }

  private find(query: string) {
    const total = this.page.setQuery(query);
    if (!query) return this.say('', 'info');
    if (!total) return this.say(`no matches for "${query}"`, 'warn');
    this.say(`match ${this.page.nextMatch(1)} of ${total} · n next · N previous`, 'info');
  }

  // ---- keys -----------------------------------------------------------------------

  private onKey = (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c') return this.quit();
    if (this.prompt?.kind === 'secret') {
      key.preventDefault();
      return this.secretKey(key);
    }
    if (this.prompt) {
      // Everything else goes to the input; Enter arrives as its ENTER event.
      if (key.name === 'escape') {
        key.preventDefault();
        this.cancelPrompt();
      } else if (key.name === 'tab' && this.prompt.kind === 'field') {
        key.preventDefault();
        this.submitPrompt(this.input.value, false);
      }
      return;
    }
    // Handled here, so a prompt opened by this key doesn't also receive it.
    key.preventDefault();
    if (this.help.visible) {
      this.help.visible = false;
      return;
    }
    if (this.picker) return this.pickerKey(key);
    if (this.refsBox.visible) return this.refsKey(key);
    // Before the dialog keys, so a y here answers the quit question, not a page dialog.
    if (this.quitting !== 'no') return this.quitKey(key);
    if (this.dialog && this.dialogKey(key)) return;
    if (this.digitKey(key)) return;
    this.browseKey(key);
  };

  /** Keys for a password prompt, which never hands its text to the visible input. */
  private secretKey(key: KeyEvent) {
    if (key.name === 'escape') return this.cancelPrompt();
    if (key.name === 'return' || key.name === 'enter') return this.submitPrompt(this.secret, true);
    if (key.name === 'tab') return this.submitPrompt(this.secret, false);
    if (key.name === 'backspace') this.secret = [...this.secret].slice(0, -1).join('');
    else if (key.ctrl && key.name === 'u') this.secret = '';
    else if (!key.ctrl && !key.meta && key.sequence && !/[\u0000-\u001f\u007f]/.test(key.sequence)) this.secret += key.sequence;
    else return;
    this.input.value = '•'.repeat([...this.secret].length);
  }

  private onPaste = (e: PasteEvent) => {
    if (this.prompt?.kind !== 'secret') return; // other prompts' input handles its own pastes
    e.preventDefault();
    this.secret += new TextDecoder().decode(e.bytes).replace(/[\r\n]+/g, '');
    this.input.value = '•'.repeat([...this.secret].length);
  };

  private dialogKey(key: KeyEvent): boolean {
    if (key.name === 'y') void this.run('dialog', { action: 'accept' });
    else if (key.name === 'n' || key.name === 'escape') void this.run('dialog', { action: 'dismiss' });
    else return false;
    return true;
  }

  /** Typing a ref's number and pressing Enter opens it, as in Lynx. */
  private digitKey(key: KeyEvent): boolean {
    if (/^[0-9]$/.test(key.name) && !key.ctrl && !key.meta) this.digits += key.name;
    else if (!this.digits) return false;
    else if (key.name === 'backspace') this.digits = this.digits.slice(0, -1);
    else if (key.name === 'escape') this.digits = '';
    else if (key.name === 'return') {
      const n = Number(this.digits);
      this.digits = '';
      this.activateNumber(n);
    } else return false;
    this.drawStatus();
    return true;
  }

  private browseKey(key: KeyEvent) {
    const ch = key.sequence;
    switch (key.name) {
      case 'tab':
        return this.describe(this.page.selectNext(key.shift ? -1 : 1));
      case 'h': {
        const ref = this.page.selectedRef;
        if (ref) return void this.run('hover', { ref: ref.ref });
        return this.say('press Tab to pick something to hover over', 'info');
      }
      case 'return': {
        const ref = this.page.selectedRef;
        if (ref) this.activate(ref);
        else this.say('press Tab to pick a link, or type its number', 'info');
        return;
      }
      case 'escape':
        this.page.select(null);
        this.page.setQuery('');
        return this.say('', 'info');
      case 'up':
      case 'k':
        return this.page.scrollBy(-1);
      case 'down':
      case 'j':
        return this.scrollDown(() => this.page.scrollBy(1));
      case 'pageup':
        return this.page.pageBy(-1);
      case 'pagedown':
      case 'space':
        return this.scrollDown(() => this.page.pageBy(1));
      case 'home':
        return this.page.scrollToEnd('top');
      case 'end':
        return this.page.scrollToEnd('bottom');
      case 'b':
        if (key.shift) return void this.openPicker(); // B: bookmarks and history
        return void this.run('back');
      case 'left':
      case 'backspace':
        return void this.run('back');
      case 'right':
      case 'f':
        return void this.run('forward');
      case 'r':
        return void this.run('reload', { hard: key.shift });
      case 'w':
        this.picturesFor = null; // pictures may have loaded or changed too
        return void this.run('wait', { seconds: 2 });
      case 'v':
        return this.cycleGrid();
      case 'a':
        return this.bookmark();
      case 'o':
        return this.openPrompt({ kind: 'url', label: 'open' }, this.current?.url ?? '');
      case 'l':
        if (key.ctrl) return this.openPrompt({ kind: 'url', label: 'open' }, this.current?.url ?? '');
        return this.openRefs();
      case 'q':
        if (key.shift) return this.quit(); // Q quits without asking, as in Lynx
        this.quitting = 'confirm';
        return this.drawStatus();
    }
    if (ch === '?') {
      this.help.visible = true;
      return;
    }
    if (ch === '[' || ch === ']') {
      const { current, count } = this.tabs;
      if (count < 2) return this.say('there is only one tab', 'info');
      const n = ((current - 1 + (ch === ']' ? 1 : -1) + count) % count) + 1;
      return void this.run('tab', { n });
    }
    if (ch === '/') return this.openPrompt({ kind: 'find', label: 'find' });
    if (ch === ':') return this.openPrompt({ kind: 'command', label: 'command' });
    if (ch === 'n' || ch === 'N') {
      if (!this.page.matchCount) return;
      const at = this.page.nextMatch(ch === 'n' ? 1 : -1);
      return this.say(`match ${at} of ${this.page.matchCount} · n next · N previous`, 'info');
    }
  }

  // ---- the refs pull-down ------------------------------------------------------------

  private openRefs() {
    if (!this.current) return this.say('no page is open', 'info');
    this.refList.setItems(refItems(this.current.labels, this.current.hrefs));
    const w = this.renderer.width;
    this.refsBox.width = Math.max(30, Math.min(w - 2, Math.max(60, Math.floor(w * 0.7))));
    this.sizeRefs();
    this.refsBox.visible = true;
  }

  private refreshRefs() {
    const filter = this.refList.filter;
    this.refList.setItems(refItems(this.current?.labels ?? [], this.current?.hrefs ?? []));
    this.refList.setFilter(filter);
    this.sizeRefs();
  }

  /** Fit the box to what's listed (up to the screen) and say so in its title. */
  private sizeRefs() {
    const { shown, all } = this.refList.count;
    this.refsBox.height = Math.max(3, Math.min(shown + 2, this.renderer.height - 3));
    const filter = this.refList.filter;
    const what = filter ? `${shown} of ${all} refs match "${filter}"` : `${all} refs · type to filter`;
    this.refsBox.title = ` ${what} · Enter opens · Esc closes `;
  }

  private closeRefs() {
    this.refsBox.visible = false;
  }

  private refsKey(key: KeyEvent) {
    const list = this.refList;
    switch (key.name) {
      case 'escape':
        if (list.filter) {
          list.setFilter('');
          return this.sizeRefs();
        }
        return this.closeRefs();
      case 'return':
      case 'enter': {
        const item = list.selected;
        if (item) this.pickRef(item);
        return;
      }
      case 'up':
        return list.move(-1);
      case 'down':
        return list.move(1);
      case 'pageup':
        return list.move(-list.pageSize);
      case 'pagedown':
        return list.move(list.pageSize);
      case 'home':
        return list.move(-Infinity);
      case 'end':
        return list.move(Infinity);
      case 'backspace':
        list.setFilter([...list.filter].slice(0, -1).join(''));
        return this.sizeRefs();
    }
    const ch = key.sequence;
    if (ch && !key.ctrl && !key.meta && [...ch].length === 1 && !/[\u0000-\u001f\u007f]/.test(ch)) {
      list.setFilter(list.filter + ch);
      this.sizeRefs();
    }
  }

  /** Open a ref from the list: as if it were chosen on the page. */
  private pickRef(item: RefItem) {
    this.closeRefs();
    const ref = this.page.hasRef(item.ref);
    if (ref) this.activate(ref);
    else void this.run('click', { ref: item.ref });
  }

  // ---- bookmarks and history ------------------------------------------------------

  private bookmark() {
    const p = this.current;
    if (!p) return this.say('no page to bookmark', 'info');
    if (addBookmark({ title: p.title || p.url, url: p.url })) this.say(`bookmarked "${p.title || p.url}" · B lists bookmarks`, 'ok');
    else this.say('this page is already bookmarked · B lists bookmarks', 'info');
  }

  /** B: the bookmarks, then this tab's history (newest first), numbered to open with a number and Enter. */
  private async openPicker() {
    const items: PickItem[] = readBookmarks().map((b, i) => ({ kind: 'bookmark', n: i + 1, ...b }));
    if (this.current) {
      try {
        const h = JSON.parse((await this.backend.request('history', { json: true })).text) as {
          current: number;
          entries: { url: string; title: string }[];
        };
        h.entries.forEach((e, i) => items.push({ kind: 'history', n: i + 1, title: e.title, url: e.url, current: i + 1 === h.current }));
      } catch {
        // an older session without history; bookmarks only
      }
    }
    // Newest history first, after the bookmarks.
    const bookmarks = items.filter((i) => i.kind === 'bookmark');
    const history = items.filter((i) => i.kind === 'history').reverse();
    this.picker = { items: [...bookmarks, ...history], digits: '' };
    this.drawPicker();
  }

  private drawPicker() {
    const p = this.picker;
    if (!p) {
      this.pages.visible = false;
      return;
    }
    const width = Math.max(20, this.renderer.width - 8);
    const line = (i: number, it: PickItem) => {
      const mark = it.kind === 'history' && it.current ? '• ' : '  ';
      const url = it.url.replace(/^https?:\/\//, '');
      return fitText(`${String(i + 1).padStart(3)}  ${mark}${it.title || '(untitled)'}  ${url}`, width);
    };
    const nb = p.items.filter((i) => i.kind === 'bookmark').length;
    const rows: string[] = [];
    rows.push(nb ? 'bookmarks' : 'no bookmarks yet: a bookmarks the page you are on');
    p.items.forEach((it, i) => {
      if (i === nb) rows.push("this tab's history, newest first (• is this page)");
      rows.push(line(i, it));
    });
    const max = Math.max(3, this.renderer.height - 8);
    const shown = rows.length > max ? [...rows.slice(0, max - 1), `  … ${rows.length - max + 1} more`] : rows;
    shown.push('', p.digits ? `open ${p.digits}▏ Enter opens · d deletes a bookmark · Esc closes` : 'a number, then Enter opens it (then d deletes a bookmark) · Esc closes');
    this.pagesText.content = shown.join('\n');
    this.pages.height = shown.length + 2;
    this.pages.visible = true;
  }

  private pickerKey(key: KeyEvent) {
    const p = this.picker!;
    if (/^[0-9]$/.test(key.name)) p.digits += key.name;
    else if (key.name === 'backspace') p.digits = p.digits.slice(0, -1);
    else if (key.name === 'return' || key.name === 'd') {
      const n = Number(p.digits);
      const item = p.items[n - 1];
      if (!item) {
        p.digits = '';
        this.say(n ? `there is no line ${n} in the list` : 'type the number of a line first', 'error');
      } else if (key.name === 'd') {
        if (item.kind !== 'bookmark') this.say('only bookmarks can be deleted', 'info');
        else {
          const gone = removeBookmark(item.n);
          this.say(gone ? `deleted the bookmark "${gone.title}"` : 'that bookmark was already gone', 'ok');
          return void this.openPicker(); // renumbered
        }
        p.digits = '';
      } else {
        this.closePicker();
        if (item.kind === 'bookmark') void this.run('goto', { url: item.url }, { start: true });
        else if (!item.current) void this.run('history', { n: item.n });
        return;
      }
    } else return this.closePicker();
    this.drawPicker();
  }

  private closePicker() {
    this.picker = null;
    this.drawPicker();
  }

  /** Say where a selected link goes, or what Enter does to a selected control, as a browser's status bar would. */
  private describe(ref: PageRef | undefined) {
    if (!ref) return this.say('nothing to select on this page', 'info');
    const href = this.current?.hrefs?.find(([n]) => n === ref.ref)?.[1];
    if (ref.kind === 'link') return this.say(href ? `→ ${href}` : '', 'info');
    const verb = FIELD_KINDS.has(ref.kind) ? 'type into it' : ref.kind === 'select' ? 'choose an option' : 'click it';
    this.say(`Enter to ${verb} · h to hover`, 'info');
  }

  /** q asks "Quit medley?", then whether to keep the session. y/n answer; any other key stays. */
  private quitKey(key: KeyEvent) {
    const step = this.quitting;
    this.quitting = 'no';
    if (step === 'confirm' && key.name === 'y') {
      if (!this.current) return this.quit(); // no session to ask about
      this.quitting = 'session';
    } else if (step === 'session' && key.name === 'y') {
      return this.quit();
    } else if (step === 'session' && key.name === 'n') {
      return void this.stopAndQuit();
    }
    this.drawStatus();
  }

  private async stopAndQuit() {
    this.say('stopping the browser session…', 'info');
    try {
      await this.backend.request('stop');
      this.stopped = true;
    } catch (e) {
      this.stopped = (e as Error).message.startsWith('no browser session'); // it was already gone
    }
    this.quit();
  }

  private cycleGrid() {
    const mode = GRID_MODES[(GRID_MODES.indexOf(this.page.gridMode) + 1) % GRID_MODES.length];
    this.page.gridMode = mode;
    const columns = this.page.columnCount;
    let detail = '';
    if (this.page.drawsPage) detail = ' · the page as laid out, with its colors and pictures';
    else if (mode === 'advanced' && this.current && !this.current.visual) {
      // A session started before advanced grid existed sends no page layout.
      detail = ' · this session is too old to send the page layout; restart it (q, y, n, then tui)';
    } else if (mode !== 'none') {
      detail = columns ? ` · ${columns} ${columns === 1 ? 'group' : 'groups'} in columns` : ' · nothing here fits side by side at this width';
    }
    this.say(`${GRID_LABELS[mode]}${detail} · v to switch`, 'info');
    this.drawTop();
    void this.loadPictures();
  }

  /** In advanced grid, fetch a screenshot of the page (once per document) for its pictures. */
  private async loadPictures() {
    const doc = this.current?.doc;
    if (!doc || this.page.gridMode !== 'advanced' || this.picturesFor === doc) return;
    if (!this.current?.visual?.images.length) return;
    this.picturesFor = doc;
    try {
      const reply = await this.backend.request('screenshot');
      const shot = JSON.parse(reply.text) as Screenshot;
      if (this.current?.doc !== doc) return; // moved on meanwhile
      const image = NativeImage.decode(Buffer.from(shot.jpeg, 'base64'));
      try {
        const raw = image.raw('rgba8');
        this.page.setPixels({ data: raw.data, width: raw.width, height: raw.height, stride: raw.stride, scale: raw.width / shot.width });
      } finally {
        image.dispose();
      }
    } catch {
      this.picturesFor = null; // try again next time
    }
  }

  /** Scrolling past the end asks the browser to scroll too, which loads lazy content. */
  private scrollDown(scroll: () => void) {
    if (this.page.atBottom && this.current && !this.busy) void this.run('scroll', { to: 'bottom' });
    else scroll();
  }

  // ---- drawing --------------------------------------------------------------------

  private say(text: string, tone: Tone) {
    this.message = { text, tone };
    this.drawStatus();
  }

  private draw() {
    this.drawTop();
    this.drawStatus();
    this.hints.set([{ text: ` ${this.dialog ? 'y accept · n dismiss the dialog' : HINTS}` }]);
  }

  /** While a command runs, a light band sweeps back and forth across the badge. */
  private animateBadge(on: boolean) {
    if (on && !this.badgeTimer) {
      this.badgeFrame = 0;
      let second = 0;
      this.badgeTimer = setInterval(() => {
        this.badgeFrame++;
        this.drawTop();
        // The status line counts seconds on slow commands.
        const s = Math.floor((Date.now() - this.busySince) / 1000);
        if (s !== second) {
          second = s;
          this.drawStatus();
        }
      }, BADGE_FRAME_MS);
    } else if (!on && this.badgeTimer) {
      clearInterval(this.badgeTimer);
      this.badgeTimer = undefined;
    }
  }

  private badge(): Segment[] {
    const plain = { fg: THEME.accentFg, attrs: TextAttributes.BOLD };
    if (!this.badgeTimer) return [{ text: BADGE, bg: THEME.accentBg, ...plain }];
    const f = this.badgeFrame % BADGE_SWEEP;
    const head = f < BADGE.length ? f : BADGE_SWEEP - f; // 0 → 7 → 0
    const glow = THEME.accentGlow;
    return [...BADGE].map((ch, i) => ({
      text: ch,
      bg: glow[Math.max(0, glow.length - 1 - Math.abs(i - head))],
      ...plain,
    }));
  }

  /** What a command is doing, in words, for the status line while it runs. */
  private describeCommand(cmd: string, args: Record<string, unknown>): string {
    const ref = Number(args.ref);
    const label = this.current?.labels.find(([n]) => n === ref)?.[1] ?? `[${args.ref}]`;
    switch (cmd) {
      case 'goto':
        if (args.search) return `searching for "${args.search}"`;
        return `opening ${String(args.url).replace(/^https?:\/\//, '')}`;
      case 'click':
        return `clicking ${label}`;
      case 'type':
        return `typing into ${label}`;
      case 'select':
        return `choosing in ${label}`;
      case 'upload':
        return `choosing files for ${label}`;
      case 'hover':
        return `hovering over ${label}`;
      case 'reload':
        return args.hard ? 'reloading, bypassing the cache' : 'reloading';
      case 'back':
        return 'going back';
      case 'forward':
        return 'going forward';
      case 'scroll':
        return 'scrolling';
      case 'wait':
        return `waiting ${args.seconds}s for the page`;
      case 'tab':
        return `switching to tab ${args.n}`;
      case 'history':
        return args.n === undefined ? 'reading the history' : `going to page ${args.n} of the history`;
      case 'dialog':
        return 'answering the dialog';
      case 'stop':
        return 'stopping the session';
      default:
        return cmd;
    }
  }

  private drawTop() {
    const p = this.current;
    const left: Segment[] = [...this.badge(), { text: ' ' }];
    if (p) left.push({ text: p.title || '(untitled)', attrs: TextAttributes.BOLD }, { text: `  ${p.url}`, fg: THEME.barDim });
    else left.push({ text: 'no page open', fg: THEME.barDim });
    const grid = this.page.gridMode === 'none' ? '' : ` · ${GRID_LABELS[this.page.gridMode]}`;
    const tab = this.tabs.count > 1 ? `tab ${this.tabs.current}/${this.tabs.count} · ` : '';
    const right: Segment[] = p ? [{ text: `${tab}${this.page.refCount} refs · ${this.page.position}${grid} `, fg: THEME.barDim }] : [];
    this.top.set(left, right);
  }

  /** The logo stands in for the page until there is one, saying what's being done. */
  private drawSplash() {
    this.splash.show(!this.current);
    const s = Math.floor((Date.now() - this.busySince) / 1000);
    this.splash.setNote(this.busy && this.doing ? `${this.doing}…${s >= 2 ? ` ${s}s` : ''}` : '');
  }

  private drawStatus() {
    this.drawSplash();
    let left: Segment[];
    const question = {
      confirm: ' Quit medley? y to quit, any other key to stay',
      session: ' Keep the browser session running? y keep it · n stop it · any other key to stay',
    };
    if (this.quitting !== 'no') left = [{ text: question[this.quitting], fg: THEME.warn }];
    else if (this.prompt && this.promptError) left = [{ text: ` ${this.promptError}`, fg: THEME.error }];
    else if (this.prompt) left = [{ text: ` ${PROMPT_HINTS[this.prompt.kind]}`, fg: THEME.dim }];
    else if (this.busy && this.doing) {
      const s = Math.floor((Date.now() - this.busySince) / 1000);
      left = [{ text: ` ${this.doing}…${s >= 2 ? ` ${s}s` : ''}`, fg: THEME.dim }];
    }
    else if (this.digits) left = [{ text: ` ref ${this.digits}▏ Enter to open · Esc to cancel`, fg: THEME.link }];
    else if (this.dialog) left = [{ text: ` ⚠ the page asks (${this.dialog.type}): "${this.dialog.message}"`, fg: THEME.warn }];
    else left = [{ text: ` ${this.message.text}`, fg: TONE[this.message.tone] }];
    const right: Segment[] = [];
    if (this.activity) right.push({ text: this.activity, fg: THEME.agent });
    right.push({ text: this.connected ? ' ● ' : ' ○ ', fg: this.connected ? THEME.ok : THEME.dim });
    this.status.set(left, right);
  }
}
