// Chrome/Edge over the DevTools protocol, with no dependencies: launch the
// browser, talk CDP over its WebSocket, drive pages.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, sessionId, resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        this.pending.delete(id);
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

export class Page {
  private inflight = new Set<string>();
  private loading = false; // the main frame is loading a new document
  private mainFrameId = '';
  // Medley's scripts run in an isolated world of the page's main frame: they
  // share its DOM but not its JavaScript, so the page can neither see nor
  // forge the ref table, and its changes to built-ins can't break them. Each
  // new document needs a new world.
  private world: number | null = null;
  onDialog: ((d: Dialog) => void) | null = null;
  closed = false; // the tab went away; waiting on it is pointless

  constructor(
    private cdp: CDP,
    private sessionId: string,
    readonly targetId: string,
    readonly width: number,
    readonly height: number,
  ) {}

  async init() {
    this.on((method, p) => {
      switch (method) {
        case 'Network.requestWillBeSent':
          this.inflight.add(p.requestId);
          break;
        case 'Network.loadingFinished':
        case 'Network.loadingFailed':
          this.inflight.delete(p.requestId);
          break;
        case 'Page.frameStartedLoading':
          if (p.frameId === this.mainFrameId) this.loading = true;
          break;
        case 'Page.frameStoppedLoading':
          if (p.frameId === this.mainFrameId) this.loading = false;
          break;
        case 'Page.javascriptDialogOpening':
          this.onDialog?.({ type: p.type, message: p.message, defaultPrompt: p.defaultPrompt });
          break;
        case 'Page.frameNavigated':
          if (!p.frame.parentId) {
            this.mainFrameId = p.frame.id;
            this.world = null; // a new document
          }
          break;
      }
    });
    await this.send('Page.enable');
    await this.send('Network.enable');
    const { frameTree } = await this.send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  send(method: string, params: object = {}): Promise<any> {
    return this.cdp.send(method, params, this.sessionId);
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
    const stopped = this.waitFor('Page.frameStoppedLoading', 20000, (p) => p.frameId === this.mainFrameId);
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`could not open ${url}: ${nav.errorText}`);
    if (nav.loaderId) await stopped; // same-document (#hash) navigations have no loader
    await this.settle();
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
   * navigation it started, then the network and the DOM going quiet.
   */
  async settle() {
    await sleep(100); // give a click or key press a moment to start a navigation or requests
    for (let round = 0; round < 3 && !this.closed; round++) {
      const deadline = Date.now() + 15000;
      while (this.loading && !this.closed && Date.now() < deadline) await sleep(50);
      await Promise.all([this.networkQuiet(), this.evaluate(DOM_QUIET(300, 1500)).catch(() => {})]);
      if (!this.loading) return;
    }
  }

  private async networkQuiet(idle = 400, max = 4000) {
    // Long-polls and analytics beacons never finish, so allow a couple in flight.
    const until = Date.now() + max;
    let quietSince = Date.now();
    while (Date.now() < until && !this.closed) {
      if (this.inflight.size > 2) quietSince = Date.now();
      else if (Date.now() - quietSince >= idle) return;
      await sleep(50);
    }
  }

  /** Evaluate in medley's isolated world (see `world`), creating it for this document if needed. */
  async evaluate<T>(expression: string): Promise<T> {
    const run = async () => {
      this.world ??= (await this.send('Page.createIsolatedWorld', { frameId: this.mainFrameId, worldName: 'medley' })).executionContextId;
      return this.send('Runtime.evaluate', { expression, contextId: this.world, returnByValue: true, awaitPromise: true });
    };
    let r;
    try {
      r = await run();
    } catch (e) {
      // The document changed under us (its world went with it); make one in the new document.
      if (!/context/i.test((e as Error).message)) throw e;
      this.world = null;
      r = await run();
    }
    if (r.exceptionDetails) {
      throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value as T;
  }

  async click(x: number, y: number) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
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
}

export class Browser {
  private popups: { targetId: string; openerId: string }[] = [];
  readonly exited: Promise<void>;

  private constructor(
    private proc: ChildProcess,
    private cdp: CDP,
    private dir: string,
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
    });
  }

  /** Called when a tab closes, whether we closed it or the page did (window.close()). */
  onTargetClosed: ((targetId: string) => void) | null = null;

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
  }: LaunchOptions = {}): Promise<Browser> {
    const dir = mkdtempSync(join(tmpdir(), 'medley-'));
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
      '--mute-audio',
      `--window-size=${width},${height}`,
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new', '--hide-scrollbars');
    const proc = spawn(executable, args, { stdio: 'ignore' });
    try {
      // Chrome writes the port it picked (and the browser endpoint path) here once it's listening.
      const portFile = join(dir, 'DevToolsActivePort');
      const deadline = Date.now() + 15000;
      let lines: string[] = [];
      while (true) {
        try {
          lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
        } catch {
          // not written yet, or (on Windows) still locked while Chrome writes it
        }
        if (lines.length >= 2 && lines[1]) break;
        if (proc.exitCode !== null) throw new Error(`browser exited during startup (code ${proc.exitCode})`);
        if (Date.now() > deadline) throw new Error('timed out waiting for the browser to start');
        await sleep(50);
      }
      const cdp = await CDP.connect(`ws://127.0.0.1:${lines[0].trim()}${lines[1].trim()}`);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
      return new Browser(proc, cdp, dir, width, height);
    } catch (e) {
      killTree(proc);
      await removeDir(dir);
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
    await removeDir(this.dir);
  }

  /** Synchronous last-resort cleanup for signal handlers. */
  kill() {
    killTree(this.proc);
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
