// Chrome/Edge over the DevTools protocol, with no dependencies: launch the
// browser, talk CDP over its WebSocket, drive pages.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { KeyPress } from './keys.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

export function findBrowser(): string {
  const fromEnv = process.env.MEDLEY_BROWSER || process.env.CHROME_PATH;
  if (fromEnv) return fromEnv;
  const found = (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p));
  if (!found) throw new Error('no Chrome/Edge found; pass --browser <path> or set MEDLEY_BROWSER');
  return found;
}

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

/**
 * How long the browser has to answer a request (MEDLEY_PAGE_TIMEOUT seconds,
 * default 30). A page stuck in a script never answers anything sent to it;
 * without a limit, that would hold up the session for good.
 */
const ANSWER_MS = (Number(process.env.MEDLEY_PAGE_TIMEOUT) || 30) * 1000;

/** The browser didn't answer in time: most likely, a script on the page is stuck. */
export class NoAnswer extends Error {}

export class CDP {
  private seq = 0;
  private pending = new Map<
    number,
    { method: string; sessionId?: string; resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(m: Msg) => void>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.dispatch(JSON.parse(String(ev.data))));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: browser connection closed`));
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true });
    });
  }

  private dispatch(m: Msg) {
    if (m.id === undefined) {
      for (const fn of this.listeners) fn(m);
      // A tab that closed will never answer what was sent to it (a click that closed it, say).
      if (m.method === 'Target.detachedFromTarget') {
        for (const [id, p] of this.pending) {
          if (p.sessionId !== m.params.sessionId) continue;
          this.pending.delete(id);
          p.reject(new Error(`${p.method}: the tab closed`));
        }
      }
      return;
    }
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
    else p.resolve(m.result);
  }

  send(method: string, params: object = {}, sessionId?: string, timeout = ANSWER_MS): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new NoAnswer(`${method}: no answer in ${Math.round(timeout / 1000)}s`));
      }, timeout);
      (timer as any).unref?.();
      const settle = <T>(fn: (v: T) => void) => (v: T) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(id, { method, sessionId, resolve: settle(resolve), reject: settle(reject) });
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  }

  on(fn: (m: Msg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.ws.close();
  }
}

export interface Dialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt?: string;
}

// Resolves when the page's DOM has stopped changing for `quiet` ms (at most `max` ms).
const DOM_QUIET = (quiet: number, max: number) => `new Promise((resolve) => {
  const start = () => {
    let timer = setTimeout(done, ${quiet});
    const cap = setTimeout(done, ${max});
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${quiet}); });
    mo.observe(document, { subtree: true, childList: true, characterData: true });
    function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(true); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})`;

// Requests that can't change a page's text or structure, so the page is
// settled without waiting for them (images keep arriving long after the text
// is there), and long-lived streams that never finish.
const IGNORED_REQUESTS = new Set([
  'Image', 'Media', 'Font', 'Ping', 'Manifest', 'CSPViolationReport', 'TextTrack',
  'Prefetch', 'Preflight', 'EventSource', 'WebSocket', 'SignedExchange',
]);
// A request still open after this long is a long-poll or a stream; settling doesn't wait for it.
const STALE_REQUEST_MS = 3000;
// The longest an action waits for the page to settle, and a navigation for its new document to be parsed.
const SETTLE_MS = 15_000;
const PARSE_MS = 10_000;

/** How the page's document arrived: the response, and the connection's security when it was https. */
export interface DocumentResponse {
  requestId: string;
  url: string;
  status: number;
  statusText: string;
  mimeType: string;
  protocol?: string; // h2, http/1.1, h3
  remoteAddress?: string;
  fromCache?: boolean;
  securityState?: string; // secure, insecure, neutral
  security?: {
    protocol: string; // TLS 1.3
    keyExchange: string;
    cipher: string;
    subject: string;
    issuer: string;
    validFrom: number; // seconds since 1970
    validTo: number;
    sans: string[];
  };
}

/** Something the page logged to its console, or an error it didn't catch. */
export interface ConsoleEntry {
  at: number;
  level: 'error' | 'warning' | 'info' | 'log' | 'debug';
  text: string;
  where?: string; // script:line
}

/** A request the page made, and how it went: a status, or why it failed. */
export interface RequestEntry {
  at: number;
  url: string;
  method: string;
  type: string; // Document, Script, XHR, Fetch, Image, …
  status?: number;
  failed?: string; // net::ERR_…, blocked (…), canceled
  loader: string;
}

const MAX_CONSOLE = 500;
const MAX_REQUESTS = 2000;
// A page being developed: its console is heard from the start (see Page.watchConsole).
const LOCAL_PAGE = /^(file:|https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/:]+\.localhost|[^/:]+\.test)(:\d+)?(\/|$))/i;

interface Preview {
  subtype?: string;
  overflow?: boolean;
  properties?: { name: string; type: string; value?: string }[];
}

/** A console argument as text: a string as it is, an object as its preview ({code: 42}), anything else as the console describes it. */
function describeArg(a: { type: string; subtype?: string; value?: unknown; description?: string; unserializableValue?: string; preview?: Preview }): string {
  if (a.type === 'string') return String(a.value);
  if (a.unserializableValue) return a.unserializableValue;
  if (a.value !== undefined) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
  const p = a.preview;
  if (p?.properties && a.subtype !== 'error') {
    const more = p.overflow ? ', …' : '';
    const value = (v: { type: string; value?: string }) => (v.type === 'string' ? JSON.stringify(v.value) : (v.value ?? v.type));
    if (p.subtype === 'array') return `[${p.properties.map(value).join(', ')}${more}]`;
    return `{${p.properties.map((v) => `${v.name}: ${value(v)}`).join(', ')}${more}}`;
  }
  return a.description ?? a.type;
}

/** A frame of the page, and the CDP session that owns its document. */
interface Frame {
  session: string;
  parentId: string | null;
}

export class Page {
  private inflight = new Map<string, { at: number; loader: string }>(); // requests that may still change the page
  private loading = false; // the main frame is loading a new document, and hasn't parsed it yet
  private mainFrameId = '';
  // Medley's scripts run in an isolated world of the page's main frame: they
  // share its DOM but not its JavaScript, so the page can neither see nor
  // forge the ref table, and its changes to built-ins can't break them. Each
  // new document needs a new world.
  private world: number | null = null;
  // Every frame, and medley's world in each child frame it has looked into.
  // Cross-site frames run in their own process, reached through their own
  // session (auto-attached); others belong to the page's session.
  private frames = new Map<string, Frame>();
  private worlds = new Map<string, number>();
  private childSessions = new Set<string>();
  private targets = new Map<string, string>(); // cross-site frame id → the session of its own process
  private attaching = new Set<Promise<void>>(); // cross-site frames still being set up
  private framesChangedAt = 0;

  /** Whether frames are still appearing (attaching, or added or navigated in the last moment). */
  get framesSettling(): boolean {
    return this.attaching.size > 0 || Date.now() - this.framesChangedAt < 2000;
  }
  document: DocumentResponse | null = null; // how the page's document arrived
  // The current document's console messages and requests, oldest first (as DevTools keeps them).
  console: ConsoleEntry[] = [];
  requests = new Map<string, RequestEntry>();
  private consoleOn = false; // see watchConsole
  onDialog: ((d: Dialog) => void) | null = null;
  onNavigated: (() => void) | null = null; // the main frame got a new document
  closed = false; // the tab went away; waiting on it is pointless
  private offs: (() => void)[] = []; // this page's listeners on the browser connection (see dispose)

  constructor(
    private cdp: CDP,
    private sessionId: string,
    readonly targetId: string,
    readonly width: number,
    readonly height: number,
  ) {}

  async init() {
    const off = this.on((method, p) => {
      switch (method) {
        case 'Network.requestWillBeSent':
          this.requestStarted(p);
          this.logRequest(p);
          break;
        case 'Network.loadingFinished':
          this.inflight.delete(p.requestId);
          break;
        case 'Network.loadingFailed': {
          this.inflight.delete(p.requestId);
          const r = this.requests.get(p.requestId);
          if (r) r.failed = p.blockedReason ? `blocked (${p.blockedReason})` : p.canceled ? 'canceled' : p.errorText;
          break;
        }
        case 'Network.responseReceived': {
          // The main frame's id is its target's.
          if (p.type === 'Document' && (p.frameId === this.mainFrameId || p.frameId === this.targetId)) this.documentResponse(p);
          const r = this.requests.get(p.requestId);
          if (r) r.status = p.response.status;
          break;
        }
        case 'Runtime.consoleAPICalled': {
          const level = p.type === 'error' || p.type === 'assert' ? 'error' : p.type === 'warning' ? 'warning' : p.type === 'info' ? 'info' : p.type === 'debug' ? 'debug' : 'log';
          const frame = p.stackTrace?.callFrames?.[0];
          this.logConsole(level, (p.args ?? []).map(describeArg).join(' '), frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined);
          break;
        }
        case 'Runtime.exceptionThrown': {
          const d = p.exceptionDetails;
          const what = d.exception?.description?.split('\n')[0] ?? d.exception?.value ?? '';
          this.logConsole('error', `${d.text}${what ? ` ${what}` : ''}`, d.url ? `${d.url}:${d.lineNumber + 1}` : undefined);
          break;
        }
        case 'Log.entryAdded': {
          // The browser's own messages about the page's scripts and security (blocked
          // content, CSP). Failed requests are kept as requests, and the rest (sign-in
          // prompts, violations, interventions) is about the browser, not the page.
          const e = p.entry;
          if (!/^(javascript|security)$/.test(e.source) || !/^(error|warning)$/.test(e.level)) break;
          this.logConsole(e.level, e.text, e.url ? `${e.url}${e.lineNumber !== undefined ? `:${e.lineNumber + 1}` : ''}` : undefined);
          break;
        }
        case 'Page.frameStartedLoading':
          if (p.frameId === this.mainFrameId) this.loading = true;
          break;
        case 'Page.frameStoppedLoading':
          if (p.frameId === this.mainFrameId) this.loading = false;
          break;
        // The new document is parsed: what it shows is there. Its load event
        // can come many seconds later, after every ad and tracker on an ad-heavy
        // page, so settle() waits for quiet from here instead.
        case 'Page.domContentEventFired':
          this.loading = false;
          break;
        case 'Page.javascriptDialogOpening':
          this.onDialog?.({ type: p.type, message: p.message, defaultPrompt: p.defaultPrompt });
          break;
        case 'Page.frameNavigated':
          if (!p.frame.parentId) {
            this.mainFrameId = p.frame.id;
            this.world = null; // a new document
            this.frames.set(p.frame.id, { session: this.sessionId, parentId: null });
            // Requests of the old document may never report finishing; they no longer matter.
            for (const [id, r] of this.inflight) if (r.loader !== p.frame.loaderId) this.inflight.delete(id);
            // Its console and requests start over, the new document's own request kept.
            this.console = [];
            for (const [id, r] of this.requests) if (r.loader !== p.frame.loaderId) this.requests.delete(id);
            if (LOCAL_PAGE.test(p.frame.url)) void this.watchConsole();
            this.onNavigated?.();
          }
          break;
      }
    });
    const offFrames = this.cdp.on((m) => {
      if (m.method && m.sessionId && (m.sessionId === this.sessionId || this.childSessions.has(m.sessionId))) {
        this.frameEvent(m.sessionId, m.method, m.params);
      }
    });
    this.offs.push(off, offFrames);
    await this.send('Page.enable');
    await this.send('Network.enable');
    await this.send('Log.enable'); // browser messages: blocked content, security; see watchConsole for the page's own
    const { frameTree } = await this.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    this.addFrameTree(this.sessionId, frameTree, null);
    await this.watchFrames(this.sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  send(method: string, params: object = {}, timeout?: number): Promise<any> {
    return this.cdp.send(method, params, this.sessionId, timeout);
  }

  /** The tab closed: stop listening for it, so a long session doesn't collect the listeners of every tab it had. */
  dispose() {
    this.closed = true;
    for (const off of this.offs.splice(0)) off();
  }

  /**
   * Whether a script on the page is stuck (in a loop, say), so the page
   * answers nothing, not even the simplest question. If so, stop the script,
   * as a browser's "page unresponsive" dialog would. True if it had to.
   */
  async unstick(): Promise<boolean> {
    if (await this.responsive(1500)) return false;
    await this.send('Runtime.terminateExecution', {}, 3000).catch(() => {});
    return true;
  }

  /** Whether the page answers the simplest question within `timeout` ms (a script stuck in a loop blocks every answer). */
  async responsive(timeout = 5000): Promise<boolean> {
    try {
      await this.send('Runtime.evaluate', { expression: '0', returnByValue: true }, timeout);
      return true;
    } catch (e) {
      return !(e instanceof NoAnswer); // another error (between documents) isn't being stuck
    }
  }

  // ---- frames ---------------------------------------------------------------

  /** Attach to cross-site frames as they appear under this session (they run in their own process). */
  private async watchFrames(session: string) {
    await this.cdp
      .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }, { exclude: true }] }, session)
      .catch(() => {});
  }

  private addFrameTree(session: string, tree: { frame: { id: string; parentId?: string }; childFrames?: any[] }, parentId: string | null) {
    this.setFrame(tree.frame.id, session, parentId);
    for (const child of tree.childFrames ?? []) this.addFrameTree(session, child, tree.frame.id);
  }

  /** Record a frame; a parent learned once is kept (events arrive in no fixed order across sessions). */
  private setFrame(id: string, session: string, parentId: string | null | undefined) {
    const known = this.frames.get(id);
    this.frames.set(id, { session, parentId: parentId ?? known?.parentId ?? null });
  }

  private frameEvent(session: string, method: string, p: any) {
    if (method === 'Page.frameAttached' || method === 'Target.attachedToTarget' || (method === 'Page.frameNavigated' && p.frame.parentId)) {
      this.framesChangedAt = Date.now();
    }
    switch (method) {
      case 'Page.frameAttached':
        this.setFrame(p.frameId, this.frames.get(p.frameId)?.session ?? session, p.parentFrameId);
        break;
      case 'Page.frameNavigated':
        this.worlds.delete(p.frame.id); // a new document, so a new world
        if (p.frame.parentId) this.setFrame(p.frame.id, session, p.frame.parentId);
        break;
      case 'Page.frameDetached':
        if (p.reason !== 'swap') {
          this.frames.delete(p.frameId);
          this.worlds.delete(p.frameId);
        }
        break;
      case 'Target.attachedToTarget': {
        if (p.targetInfo.type !== 'iframe') return;
        // A cross-site frame: its document now lives behind this session. Its id is its target's.
        const child = p.sessionId as string;
        const id = p.targetInfo.targetId as string;
        this.childSessions.add(child);
        this.targets.set(id, child);
        // Its parent may not be known yet (it can attach before its parent's frame tree comes in).
        this.setFrame(id, this.frames.get(id)?.session ?? child, p.targetInfo.parentFrameId);
        this.worlds.delete(id);
        const setup = (async () => {
          await this.cdp.send('Page.enable', {}, child);
          await this.cdp.send('Network.enable', {}, child); // its requests count toward settling
          const { frameTree } = await this.cdp.send('Page.getFrameTree', {}, child);
          this.addFrameTree(child, frameTree, this.frames.get(id)?.parentId ?? null);
          await this.watchFrames(child);
        })().catch(() => {});
        this.attaching.add(setup);
        void setup.finally(() => this.attaching.delete(setup));
        break;
      }
      case 'Network.requestWillBeSent':
        if (session !== this.sessionId) this.requestStarted(p);
        break;
      case 'Network.loadingFinished':
      case 'Network.loadingFailed':
        if (session !== this.sessionId) this.inflight.delete(p.requestId);
        break;
      case 'Target.detachedFromTarget':
        if (!this.childSessions.delete(p.sessionId)) return;
        for (const [id, s] of this.targets) {
          if (s !== p.sessionId) continue;
          this.targets.delete(id);
          this.worlds.delete(id);
        }
        for (const [id, f] of this.frames) {
          if (f.session !== p.sessionId || this.targets.has(id)) continue;
          this.frames.delete(id);
          this.worlds.delete(id);
        }
        break;
    }
  }

  /** The session that owns a frame's document: its own if it's a cross-site frame, else its parent's. */
  private sessionOf(frameId: string): string | undefined {
    return this.targets.get(frameId) ?? this.frames.get(frameId)?.session;
  }

  /** The frames from other sites, whose documents the page's own script can't read: each is asked by itself. */
  get crossSiteFrames(): string[] {
    return [...this.targets.keys()];
  }

  /** The frames between the main frame and `frameId`, outermost first, ending with `frameId`. */
  frameChain(frameId: string): string[] {
    const chain: string[] = [];
    for (let id: string | null = frameId; id && id !== this.mainFrameId; id = this.frames.get(id)?.parentId ?? null) {
      chain.unshift(id);
      if (chain.length > 20) break;
    }
    return chain;
  }

  /** The frame `frameId` sits in (null for the main frame). */
  parentOf(frameId: string): string | null {
    const parent = this.frames.get(frameId)?.parentId ?? null;
    return parent === this.mainFrameId ? null : parent;
  }

  /**
   * Mark the <iframe> elements of `frameId`'s children in its document (in
   * medley's world there, so the page can't see or forge the marks), so an
   * extraction can tell which frame each one shows. Null means the main frame.
   */
  async markFrames(frameId: string | null) {
    // Frames that just appeared may still be attaching; give them a moment.
    for (let i = 0; i < 3 && this.attaching.size; i++) await Promise.race([Promise.all(this.attaching), sleep(1000)]);
    const parent = frameId ?? this.mainFrameId;
    const session = this.sessionOf(parent);
    if (!session) return;
    const children = [...this.frames].filter(([, c]) => c.parentId === parent).map(([id]) => id);
    for (const child of children) {
      try {
        const { backendNodeId } = await this.cdp.send('DOM.getFrameOwner', { frameId: child }, session);
        const contextId = await this.worldFor(frameId);
        const { object } = await this.cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId }, session);
        await this.cdp.send(
          'Runtime.callFunctionOn',
          {
            objectId: object.objectId,
            functionDeclaration:
              'function (k) { this.__medleyFrame = k; (window.__medleyFrames || (window.__medleyFrames = new Map())).set(k, new WeakRef(this)); }',
            arguments: [{ value: child }],
          },
          session,
        );
        await this.cdp.send('Runtime.releaseObject', { objectId: object.objectId }, session).catch(() => {});
      } catch {
        // gone already, or not in a document medley reads directly (inside a same-origin frame)
      }
    }
  }

  /** Medley's isolated world in a frame (null: the main frame), made on first use. */
  private async worldFor(frameId: string | null): Promise<number> {
    if (!frameId) {
      this.world ??= (await this.send('Page.createIsolatedWorld', { frameId: this.mainFrameId, worldName: 'medley' })).executionContextId;
      return this.world!;
    }
    const known = this.worlds.get(frameId);
    if (known !== undefined) return known;
    const session = this.sessionOf(frameId);
    if (!session) throw new Error('that frame is no longer on the page; take a new snapshot');
    const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'medley' }, session);
    this.worlds.set(frameId, executionContextId);
    return executionContextId;
  }

  on(fn: (method: string, params: any) => void): () => void {
    return this.cdp.on((m) => {
      if (m.sessionId === this.sessionId && m.method) fn(m.method, m.params);
    });
  }

  /** Resolves with the event's params, or null if it doesn't fire within `timeout`. */
  waitFor(method: string, timeout: number, match: (params: any) => boolean = () => true): Promise<any | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeout);
      (timer as any).unref?.();
      const off = this.on((m, params) => {
        if (m !== method || !match(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  async goto(url: string) {
    const parsed = this.parsed();
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`could not open ${url}: ${nav.errorText}`);
    if (nav.loaderId) await parsed; // same-document (#hash) navigations have no loader
    // The caller settles (Session.act does, after every action).
  }

  /** Reload the page, from the cache as usual or, when `hard`, from the network. */
  async reload(hard = false) {
    const parsed = this.parsed();
    await this.send('Page.reload', { ignoreCache: hard });
    await parsed;
  }

  /** Resolves when the main frame's new document is parsed, or its loading stops (a failure, a download). */
  private parsed(timeout = PARSE_MS): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, timeout);
      (timer as any).unref?.();
      const off = this.on((m, p) => {
        if (m === 'Page.domContentEventFired' || (m === 'Page.frameStoppedLoading' && p.frameId === this.mainFrameId)) done();
      });
    });
  }

  /** This tab's history: its pages, oldest first, and which one is showing. */
  async historyEntries(): Promise<{ current: number; entries: { id: number; url: string; title: string }[] }> {
    const { currentIndex, entries } = await this.send('Page.getNavigationHistory');
    return { current: currentIndex, entries: entries.map((e: any) => ({ id: e.id, url: e.url, title: e.title })) };
  }

  /** Go to an entry of this tab's history (see historyEntries). */
  async historyGo(id: number) {
    await this.send('Page.navigateToHistoryEntry', { entryId: id });
  }

  /** Go back (-1) or forward (1) in history. False if there's nowhere to go. */
  async history(delta: -1 | 1): Promise<boolean> {
    const { currentIndex, entries } = await this.send('Page.getNavigationHistory');
    const entry = entries[currentIndex + delta];
    if (!entry) return false;
    await this.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    return true;
  }

  /**
   * Wait for the page to finish reacting to whatever just happened: any
   * navigation it started, then the network and the DOM going quiet; for
   * SETTLE_MS at most. True if it was still loading its document by then (a
   * script or a request holding it up), so the caller can say what it shows
   * is only as far as it got.
   */
  async settle(): Promise<boolean> {
    await sleep(100); // give a click or key press a moment to start a navigation or requests
    const until = Date.now() + SETTLE_MS;
    for (let round = 0; round < 3 && !this.closed; round++) {
      while (this.loading && !this.closed && Date.now() < until) await sleep(50);
      if (Date.now() >= until) break;
      // A page stuck in a script can't answer; don't wait long for it to say its DOM is quiet.
      await Promise.all([this.networkQuiet(400, Math.min(4000, until - Date.now())), this.evaluate(DOM_QUIET(300, 1500), 4000).catch(() => {})]);
      if (!this.loading) return false;
    }
    return this.loading && !this.closed;
  }

  private documentResponse(p: { requestId: string; response: any }) {
    const r = p.response;
    const s = r.securityDetails;
    this.document = {
      requestId: p.requestId,
      url: r.url,
      status: r.status,
      statusText: r.statusText,
      mimeType: r.mimeType,
      protocol: r.protocol,
      remoteAddress: r.remoteIPAddress ? `${r.remoteIPAddress}${r.remotePort ? `:${r.remotePort}` : ''}` : undefined,
      fromCache: r.fromDiskCache || r.fromServiceWorker || undefined,
      securityState: r.securityState,
      security: s && {
        protocol: s.protocol,
        keyExchange: s.keyExchangeGroup || s.keyExchange,
        cipher: s.cipher,
        subject: s.subjectName,
        issuer: s.issuer,
        validFrom: s.validFrom,
        validTo: s.validTo,
        sans: s.sanList ?? [],
      },
    };
  }

  /** The document's source as the server sent it, when the browser still has it. */
  async documentSource(): Promise<string | null> {
    if (!this.document) return null;
    try {
      const { body, base64Encoded } = await this.send('Network.getResponseBody', { requestId: this.document.requestId });
      return base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
    } catch {
      return null;
    }
  }

  /** Note a request that could change what the page shows (see IGNORED_REQUESTS). */
  private logRequest(p: { requestId: string; type?: string; loaderId?: string; request: { url: string; method: string } }) {
    if (p.request.url.startsWith('data:')) return;
    const known = this.requests.get(p.requestId);
    if (known) {
      known.url = p.request.url; // a redirect goes on under the same id
      known.status = undefined;
      return;
    }
    this.requests.set(p.requestId, { at: Date.now(), url: p.request.url, method: p.request.method, type: p.type ?? 'Other', loader: p.loaderId ?? '' });
    if (this.requests.size > MAX_REQUESTS) this.requests.delete(this.requests.keys().next().value!);
  }

  /**
   * Hear the page's console messages and uncaught errors from now on (and the
   * ones the browser kept from before). Off until asked, or until a local
   * development page opens: the protocol's Runtime domain, which reports them,
   * describes every value logged, and bot checks watch for exactly that.
   */
  async watchConsole() {
    if (this.consoleOn) return;
    this.consoleOn = true;
    await this.send('Runtime.enable').catch(() => {
      this.consoleOn = false;
    });
  }

  get watchingConsole(): boolean {
    return this.consoleOn;
  }

  private logConsole(level: ConsoleEntry['level'], text: string, where?: string) {
    this.console.push({ at: Date.now(), level, text: text.length > 1000 ? text.slice(0, 999) + '…' : text, where });
    if (this.console.length > MAX_CONSOLE) this.console.shift();
  }

  private requestStarted(p: { requestId: string; type?: string; loaderId?: string; frameId?: string }) {
    if (p.type && IGNORED_REQUESTS.has(p.type)) return;
    // A frame's own page is reported finished in the frame's session, which
    // may attach after it began; frames are waited for when they're read.
    if (p.type === 'Document' && p.frameId && p.frameId !== this.mainFrameId) return;
    this.inflight.set(p.requestId, { at: Date.now(), loader: p.loaderId ?? '' });
  }

  private async networkQuiet(idle = 400, max = 4000) {
    const until = Date.now() + max;
    let quietSince = Date.now();
    while (Date.now() < until && !this.closed) {
      // Long-polls, streams and analytics never finish: a request open longer
      // than STALE_REQUEST_MS doesn't count, and a couple more are allowed.
      const now = Date.now();
      let open = 0;
      for (const [id, r] of this.inflight) {
        if (now - r.at < STALE_REQUEST_MS) open++;
        else if (now - r.at > 60_000) this.inflight.delete(id); // forget it
      }
      if (open > 2) quietSince = now;
      else if (now - quietSince >= idle) return;
      await sleep(50);
    }
  }

  /**
   * Evaluate in medley's isolated world (see `world`), creating it for this
   * document if needed; NoAnswer if the page doesn't answer within `timeout` ms.
   */
  async evaluate<T>(expression: string, timeout?: number): Promise<T> {
    return (await this.run(expression, true, null, timeout)).value as T;
  }

  /** Evaluate in medley's world in a child frame (null: the main frame). */
  async evaluateIn<T>(frameId: string | null, expression: string, timeout?: number): Promise<T> {
    return (await this.run(expression, true, frameId, timeout)).value as T;
  }

  /**
   * Give a file input (the element `expression` evaluates to, in medley's
   * world of `frameId`) these files, as if they were picked in its file
   * dialog. The page gets its usual input and change events.
   */
  async setFiles(expression: string, files: string[], frameId: string | null = null) {
    const { objectId } = await this.run(expression, false, frameId);
    if (!objectId) throw new Error('the file field went away');
    const session = frameId ? (this.sessionOf(frameId) ?? this.sessionId) : this.sessionId;
    try {
      await this.cdp.send('DOM.setFileInputFiles', { objectId, files }, session);
    } finally {
      await this.cdp.send('Runtime.releaseObject', { objectId }, session).catch(() => {});
    }
  }

  private async run(
    expression: string,
    returnByValue: boolean,
    frameId: string | null,
    timeout = ANSWER_MS,
  ): Promise<{ value?: unknown; objectId?: string }> {
    const run = async () => {
      const contextId = await this.worldFor(frameId);
      const session = frameId ? this.sessionOf(frameId)! : this.sessionId;
      return this.cdp.send('Runtime.evaluate', { expression, contextId, returnByValue, awaitPromise: true }, session, timeout);
    };
    let r;
    try {
      r = await run();
    } catch (e) {
      if (e instanceof NoAnswer) {
        throw new NoAnswer(`the page didn't answer in ${Math.round(timeout / 1000)}s: a script on it may be stuck (reload stops it)`);
      }
      // The document changed under us (its world went with it); make one in the new document.
      if (!/context/i.test((e as Error).message)) throw e;
      if (frameId) this.worlds.delete(frameId);
      else this.world = null;
      r = await run();
    }
    if (r.exceptionDetails) {
      throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result;
  }

  async click(x: number, y: number) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /**
   * Drag from one point to another with the mouse. If the page starts an
   * HTML drag (draggable="true"), the browser hands over the drag's data and
   * the drop is delivered at the target; otherwise the mouse just moves there
   * with its button down (sliders, canvases, pointer-driven lists).
   */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }) {
    let data: unknown = null;
    const off = this.on((m, p) => {
      if (m === 'Input.dragIntercepted') data = p.data;
    });
    await this.send('Input.setInterceptDrags', { enabled: true });
    try {
      const mouse = (type: string, x: number, y: number, buttons: number) =>
        this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
      await mouse('mouseMoved', from.x, from.y, 0);
      await mouse('mousePressed', from.x, from.y, 1);
      const steps = 12;
      for (let i = 1; i <= steps && !data; i++) {
        await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, 1);
        await sleep(16);
      }
      if (data) {
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await this.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
        }
      }
      await mouse('mouseReleased', to.x, to.y, 0);
    } finally {
      off();
      await this.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
  }

  hover(x: number, y: number) {
    return this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  }

  insertText(text: string) {
    return this.send('Input.insertText', { text });
  }

  async press(k: KeyPress) {
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
    await this.send('Input.dispatchKeyEvent', {
      ...base,
      type: k.text ? 'keyDown' : 'rawKeyDown',
      text: k.text,
      unmodifiedText: k.text,
    });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  wheel(deltaY: number) {
    return this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: this.width / 2,
      y: this.height / 2,
      deltaX: 0,
      deltaY,
    });
  }

  handleDialog(accept: boolean, promptText?: string) {
    return this.send('Page.handleJavaScriptDialog', { accept, promptText });
  }
}

export interface LaunchOptions {
  executable?: string;
  width?: number;
  height?: number;
  headless?: boolean;
  /** A browser profile directory to keep (cookies, logins); a throwaway one otherwise. */
  profile?: string;
  /** Where downloads go. */
  downloads?: string;
}

export const DEFAULT_DOWNLOADS = join(homedir(), 'Downloads', 'medley');

/** A download's progress, reported by the browser as it happens. */
export type DownloadEvent =
  | { state: 'started'; guid: string; name: string; url: string }
  | { state: 'done'; guid: string; name: string; path: string; bytes: number }
  | { state: 'failed'; guid: string; name: string };

export class Browser {
  private popups: { targetId: string; openerId: string }[] = [];
  private downloading = new Map<string, { name: string; received: number; total: number }>();
  readonly exited: Promise<void>;

  private constructor(
    private proc: ChildProcess,
    private cdp: CDP,
    private dir: string,
    private ephemeral: boolean, // the profile is ours to delete
    readonly downloadDir: string,
    private width: number,
    private height: number,
  ) {
    this.exited = new Promise((r) => {
      if (proc.exitCode !== null) r();
      else proc.once('exit', () => r());
    });
    cdp.on((m) => {
      const t = m.method === 'Target.targetCreated' ? m.params.targetInfo : null;
      if (t?.type === 'page' && t.openerId) this.popups.push({ targetId: t.targetId, openerId: t.openerId });
      if (m.method === 'Target.targetDestroyed' || m.method === 'Target.detachedFromTarget') {
        if (m.params.targetId) this.onTargetClosed?.(m.params.targetId);
      }
      if (m.method === 'Browser.downloadWillBegin') this.downloadBegan(m.params);
      if (m.method === 'Browser.downloadProgress') this.downloadProgressed(m.params);
    });
  }

  /** Called when a tab closes, whether we closed it or the page did (window.close()). */
  onTargetClosed: ((targetId: string) => void) | null = null;
  onDownload: ((e: DownloadEvent) => void) | null = null;

  /** Bytes received so far of the downloads still running. */
  downloadProgress(): { name: string; received: number; total: number }[] {
    return [...this.downloading.values()];
  }

  private downloadBegan(p: { guid: string; url: string; suggestedFilename: string }) {
    // The name comes from the site; keep only a plain file name.
    const name = basename(p.suggestedFilename || 'download').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_') || 'download';
    this.downloading.set(p.guid, { name, received: 0, total: 0 });
    this.onDownload?.({ state: 'started', guid: p.guid, name, url: p.url });
  }

  private downloadProgressed(p: { guid: string; state: string; receivedBytes: number; totalBytes: number }) {
    const d = this.downloading.get(p.guid);
    if (!d) return;
    d.received = p.receivedBytes;
    d.total = p.totalBytes;
    if (p.state === 'inProgress') return;
    this.downloading.delete(p.guid);
    if (p.state !== 'completed') return this.onDownload?.({ state: 'failed', guid: p.guid, name: d.name });
    // The browser saved it under its guid (see launch); give it its own name, without overwriting anything.
    void this.nameDownload(p.guid, d.name).then(
      (path) => this.onDownload?.({ state: 'done', guid: p.guid, name: basename(path), path, bytes: p.receivedBytes }),
      () => this.onDownload?.({ state: 'failed', guid: p.guid, name: d.name }),
    );
  }

  private async nameDownload(guid: string, name: string): Promise<string> {
    const from = join(this.downloadDir, guid);
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    let to = join(this.downloadDir, name);
    for (let n = 2; existsSync(to); n++) to = join(this.downloadDir, `${stem} (${n})${ext}`);
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(from, to);
        return to;
      } catch (e) {
        if (attempt >= 20) throw e;
        await sleep(100); // on Windows the browser can hold the file for a moment
      }
    }
  }

  /** Titles and addresses of the given tabs. */
  async describe(targetIds: string[]): Promise<Map<string, { title: string; url: string }>> {
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    return new Map(
      (targetInfos as { targetId: string; title: string; url: string }[])
        .filter((t) => targetIds.includes(t.targetId))
        .map((t) => [t.targetId, { title: t.title, url: t.url }]),
    );
  }

  closeTab(targetId: string) {
    return this.cdp.send('Target.closeTarget', { targetId });
  }

  static async launch({
    executable = findBrowser(),
    width = 1280,
    height = 900,
    headless = true,
    profile,
    downloads = DEFAULT_DOWNLOADS,
  }: LaunchOptions = {}): Promise<Browser> {
    let dir: string;
    if (profile) {
      mkdirSync(profile, { recursive: true });
      if (profileInUse(profile)) throw new Error(`the profile at ${profile} is in use by another browser`);
      dir = profile;
    } else {
      dir = mkdtempSync(join(tmpdir(), 'medley-'));
    }
    // A kept profile still has the last run's port file; wait for this run's.
    const portFile = join(dir, 'DevToolsActivePort');
    rmSync(portFile, { force: true });
    mkdirSync(downloads, { recursive: true });
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-breakpad',
      '--disable-background-networking',
      '--disable-component-update',
      '--hide-crash-restore-bubble',
      '--mute-audio',
      `--window-size=${width},${height}`,
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new', '--hide-scrollbars');
    const proc = spawn(executable, args, { stdio: 'ignore' });
    try {
      // Chrome writes the port it picked (and the browser endpoint path) here once it's listening.
      const deadline = Date.now() + 15000;
      let lines: string[] = [];
      while (true) {
        try {
          lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        } catch {
          // not written yet, or (on Windows) still locked while Chrome writes it
        }
        if (lines.length >= 2 && lines[1]) break;
        if (proc.exitCode !== null) {
          const hint = profile ? '; is another browser using the profile?' : '';
          throw new Error(`browser exited during startup (code ${proc.exitCode})${hint}`);
        }
        if (Date.now() > deadline) throw new Error('timed out waiting for the browser to start');
        await sleep(50);
      }
      const cdp = await CDP.connect(`ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      // Saved under their guid, then renamed once complete (see nameDownload), so a
      // half-downloaded file never sits under its real name.
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
      return new Browser(proc, cdp, dir, !profile, downloads, width, height);
    } catch (e) {
      killTree(proc);
      if (!profile) await removeDir(dir);
      throw e;
    }
  }

  async newPage(): Promise<Page> {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    return this.attach(targetId);
  }

  async attach(targetId: string): Promise<Page> {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.cdp, sessionId, targetId, this.width, this.height);
    await page.init();
    return page;
  }

  /** A tab that `openerId` opened (target=_blank, window.open) since the last call, if any. */
  takePopup(openerId: string): string | null {
    const i = this.popups.findIndex((p) => p.openerId === openerId);
    return i < 0 ? null : this.popups.splice(i, 1)[0].targetId;
  }

  async close() {
    await Promise.race([this.cdp.send('Browser.close').catch(() => {}), sleep(2000)]);
    this.cdp.close();
    if (!(await Promise.race([this.exited.then(() => true), sleep(5000).then(() => false)]))) killTree(this.proc);
    if (this.ephemeral) await removeDir(this.dir);
  }

  /** Synchronous last-resort cleanup for signal handlers. */
  kill() {
    killTree(this.proc);
  }
}

/** Whether a running browser holds this profile: Chrome locks `lockfile` (Windows) or points `SingletonLock` at its pid. */
function profileInUse(dir: string): boolean {
  if (process.platform === 'win32') {
    const lock = join(dir, 'lockfile');
    if (!existsSync(lock)) return false;
    try {
      rmSync(lock); // left behind by a browser that crashed
      return false;
    } catch {
      return true;
    }
  }
  try {
    const pid = Number(readlinkSync(join(dir, 'SingletonLock')).split('-').pop());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(proc: ChildProcess) {
  if (proc.exitCode !== null || !proc.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill('SIGKILL');
}

async function removeDir(dir: string) {
  // Chrome's helper processes can hold files for a moment after exit (especially on Windows).
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(200);
    }
  }
}
