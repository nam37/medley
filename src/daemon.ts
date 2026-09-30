// Owns one browser session and serves commands from local clients (the CLI,
// the MCP server, the terminal UI) over HTTP on 127.0.0.1. Commands run one at
// a time, and every finished command is announced on /events so a watching
// client can follow along. Exits when told to stop, when the browser goes
// away, or after 30 idle minutes. Started by client.ts; not meant to be run by hand.

import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defaultBundleDir, pruneBundles, writeBundle, type Failure } from './bundle.ts';
import { checksOf } from './checks.ts';
import { codeStamp, removeSessionInfo, writeSessionInfo, type Command, type SessionEvent } from './client.ts';
import { infoText } from './info.ts';
import { defaultScriptFile, Recording, stepFor } from './script.ts';
import { Session } from './session.ts';
import { Talk } from './talk.ts';

// How long the session waits for a command before it stops (MEDLEY_IDLE_MINUTES, default 30).
const IDLE_MS = (Number(process.env.MEDLEY_IDLE_MINUTES) || 30) * 60_000;
const HEARTBEAT_MS = 20_000; // keeps idle event streams open

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = flag('--name') ?? 'default';

const profile = flag('--profile');
const session = await Session.start({
  headless: !argv.includes('--headed'),
  executable: flag('--browser'),
  width: Number(flag('--width')) || undefined,
  profile,
  downloads: flag('--downloads'),
});
const token = randomUUID();
const watchers = new Set<(chunk: string) => void>();
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
// The conversation between an agent and the person watching (see talk.ts).
const TALK = new Set(['tell-agent', 'ask-user', 'answer', 'tell-user']);
const talk = new Talk(
  (t) => announce({ client: 'agent', cmd: 'talk', ok: true, summary: '', talk: t }),
  () => watchers.size > 0, // only the terminal UI follows /events
);
// A script being recorded (see script.ts): what anyone does in the session, as it's done.
let recording: Recording | null = null;
const REPLAYER = 'replay'; // the CLI's replay; its steps are a script already

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 255, // seconds; navigations can take a while
  async fetch(req) {
    if (req.headers.get('x-medley-token') !== token) return new Response('forbidden', { status: 403 });
    if (new URL(req.url).pathname === '/events') return eventStream(req);

    let command: Command;
    try {
      command = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'bad request' }, { status: 400 });
    }
    resetIdle();
    const client = command.client ?? 'cli';
    // stop never waits in line: it's the way out when a command is stuck on a page.
    if (command.cmd === 'stop') {
      announce({ client, cmd: 'stop', ok: true, summary: 'stopped the session' });
      setTimeout(shutdown, 50);
      return Response.json({ ok: true, text: `stopped session "${name}"`, messages: forAgent(client) });
    }
    // What the agent and the person watching say to each other never waits behind the browser.
    if (TALK.has(command.cmd)) {
      try {
        const text = await converse(command);
        return Response.json({ ok: true, text, messages: forAgent(client) });
      } catch (e) {
        return Response.json({ ok: false, error: (e as Error).message, messages: forAgent(client) });
      } finally {
        resetIdle();
      }
    }
    let refs: number[] = [];
    const run = queue.then(async () => {
      // Its sender gave up while it waited in line (a command before it took long): it isn't
      // wanted any more, and running it now would surprise whoever is at the page.
      if (req.signal.aborted) throw new Error('its sender stopped waiting for it, so it was not run');
      const started = performance.now();
      try {
        await resolveNames(command, client);
        // Written down as the page was when it was done: names come from what the client saw.
        const step = recording && client !== REPLAYER ? stepFor(command, session.labelsFor(client)) : null;
        // Where it's about to act, so a watching terminal UI can show that client's cursor there.
        refs = refsOf(command);
        if (refs.length) announce({ client, cmd: command.cmd, ok: true, summary: '', refs, starting: true });
        const text = await dispatch(command, client);
        if (step) recording?.add(step);
        const max = Number(command.args?.max);
        return max > 0 && PAGE_COMMANDS.has(command.cmd) ? session.limit(client, text, max) : text;
      } finally {
        logTiming(command, client, performance.now() - started);
      }
    });
    queue = run.catch(() => {});
    try {
      const text = await run;
      announce({ client, cmd: command.cmd, ok: true, summary: summarize(command, text, client), refs: refs.length ? refs : undefined });
      const state = command.state ? { ...session.view(client), recording: recording?.status ?? null } : undefined;
      return Response.json({ ok: true, text, state, messages: forAgent(client) });
    } catch (e) {
      const error = (e as Error).message;
      announce({ client, cmd: command.cmd, ok: false, summary: `${command.cmd} failed: ${error.split('\n')[0]}` });
      return Response.json({ ok: false, error, messages: forAgent(client) });
    } finally {
      resetIdle(); // idle time counts from when the last command finished, not when it began
    }
  },
});

function eventStream(req: Request): Response {
  let send: ((chunk: string) => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (send) watchers.delete(send);
    clearInterval(heartbeat);
  };
  const body = new ReadableStream<string>({
    start(controller) {
      send = (chunk) => {
        try {
          controller.enqueue(chunk);
        } catch {
          stop();
        }
      };
      watchers.add(send);
      heartbeat = setInterval(() => send!(': ping\n\n'), HEARTBEAT_MS);
      // A question the agent asked before this watcher came along.
      const asking = talk.asking;
      if (asking) send(`data: ${JSON.stringify({ client: 'agent', cmd: 'talk', ok: true, summary: '', talk: asking })}\n\n`);
      req.signal.addEventListener('abort', stop);
    },
    cancel: stop,
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

function announce(event: SessionEvent) {
  const chunk = `data: ${JSON.stringify({ ...event, recording: recording?.status ?? null })}\n\n`;
  for (const send of watchers) send(chunk);
}

// Commands whose result is the page, or what changed on it: a size limit (max) applies to them.
const PAGE_COMMANDS = new Set([
  'goto', 'snapshot', 'click', 'type', 'select', 'press', 'hover', 'scroll', 'upload', 'fill', 'drag',
  'back', 'forward', 'reload', 'history', 'wait', 'dialog', 'newtab', 'tab', 'close-tab',
]);

/**
 * Names in place of ref numbers ("Add to cart", "button Save") become the
 * numbers, looked up on the page (see Session.resolveRef).
 */
async function resolveNames({ cmd, args }: Command, client: string) {
  if (!args) return;
  const at = (v: unknown) => session.resolveRef(client, v);
  if (['click', 'type', 'select', 'hover', 'upload', 'inspect'].includes(cmd) && args.ref !== undefined) args.ref = await at(args.ref);
  if (cmd === 'drag' && args.from !== undefined) args.from = await at(args.from);
  if (cmd === 'scroll' && args.to !== undefined && !/^(down|up|top|bottom)$/.test(String(args.to))) args.to = await at(args.to);
  if (cmd === 'fill' && args.fields && typeof args.fields === 'object') {
    const list = Array.isArray(args.fields)
      ? args.fields.map((f: any) => ({ ref: f?.ref, value: f?.value }))
      : Object.entries(args.fields as Record<string, unknown>).map(([ref, value]) => ({ ref, value }));
    for (const f of list) f.ref = await at(f.ref);
    args.fields = list;
  }
}

/** The refs a command acts on (click 4, fill 4=… 5=…, drag 7 9), in order. */
function refsOf({ cmd, args = {} }: Command): number[] {
  const num = (v: unknown) => (/^\d+$/.test(String(v)) ? [Number(v)] : []);
  switch (cmd) {
    case 'click':
    case 'type':
    case 'select':
    case 'hover':
    case 'upload':
    case 'inspect':
      return num(args.ref);
    case 'scroll':
      return num(args.to);
    case 'drag':
      return [...num(args.from), ...num(args.to)];
    case 'fill': {
      const f = args.fields;
      if (Array.isArray(f)) return f.flatMap((x) => num((x as { ref?: unknown })?.ref));
      return f && typeof f === 'object' ? Object.keys(f).flatMap(num) : [];
    }
    default:
      return [];
  }
}

// ---- the agent and the person watching ------------------------------------------

/** What the person watching said that this client hasn't heard, when the client is an agent (not a terminal UI). */
function forAgent(client: string): string[] | undefined {
  if (client.startsWith('tui-')) return undefined;
  const lines = talk.take();
  return lines.length ? lines : undefined;
}

function converse({ cmd, args = {} }: Command): string | Promise<string> {
  switch (cmd) {
    case 'tell-agent':
      return talk.note(String(args.text ?? ''), args.about ? String(args.about) : undefined);
    case 'ask-user': {
      const choices = Array.isArray(args.choices) ? args.choices.map(String).filter(Boolean) : [];
      return talk.ask(String(args.question ?? ''), choices, Number(args.seconds) || undefined);
    }
    case 'answer':
      return talk.answer(Number(args.id), String(args.text ?? ''));
    default:
      return talk.tell(String(args.text ?? ''));
  }
}

// Each command, with how long it took and where the time went, goes to the
// session's log (~/.medley/<name>.log), for telling what makes a page slow.
const QUIET = new Set(['status', 'pictures', 'events']);
function logTiming({ cmd, args }: Command, client: string, ms: number) {
  const parts = session.takeTiming();
  if (QUIET.has(cmd)) return;
  const what = cmd === 'goto' ? `goto ${args?.url}` : cmd;
  console.log(`${new Date().toISOString()} ${client} ${what} ${Math.round(ms)}ms${parts ? ` (${parts})` : ''}`);
}

function summarize({ cmd, args }: Command, text: string, client: string): string {
  if (cmd === 'goto') return `opened ${args?.url}`;
  if (cmd === 'snapshot') return 'looked at the page';
  if (cmd === 'screenshot') return 'took a screenshot';
  if (cmd === 'pictures') return "took the page's pictures";
  if (cmd === 'tabs') return 'listed the tabs';
  if (cmd === 'downloads') return 'listed the downloads';
  if (cmd === 'info') return 'looked at the page info';
  if (cmd === 'source') return "read the page's source";
  if (cmd === 'find') return `looked for "${args?.text}"`;
  if (cmd === 'console') return 'read the console';
  if (cmd === 'network') return 'looked at the network';
  if (cmd === 'extract') return 'took data from the page';
  if (cmd === 'audit') return 'checked the page for accessibility';
  if (cmd === 'bundle') return 'saved the page as it is, to a folder';
  if (cmd === 'inspect') return `looked closely at ${session.labelsFor(client).get(Number(args?.ref)) ?? 'an element'}`;
  if (cmd === 'history' && args?.n === undefined) return 'listed the history';
  return text.split('\n')[0];
}

function ref(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a ref; refs are the numbers in a snapshot`);
  return n;
}

/** Fields to fill: [{ ref, value }], or { "4": "value" }. */
function fields(value: unknown): { ref: number; value: string }[] {
  const list = Array.isArray(value)
    ? value.map((f: any) => ({ ref: ref(f?.ref), value: String(f?.value ?? '') }))
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).map(([k, v]) => ({ ref: ref(k), value: String(v ?? '') }))
      : [];
  if (!list.length) throw new Error('fill needs at least one field: ref=value');
  return list;
}

function entry(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a history entry; history lists them`);
  return n;
}

function tab(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a tab number; tabs lists them`);
  return n;
}

/** Paths to upload: absolute (clients resolve them against their own directory), each an existing file. */
function files(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map(String) : [];
  if (!list.length) throw new Error('upload needs at least one file');
  for (const f of list) {
    if (!isAbsolute(f)) throw new Error(`"${f}" is not an absolute path`);
    let isFile = false;
    try {
      isFile = statSync(f).isFile();
    } catch {}
    if (!isFile) throw new Error(`there is no file at ${f}`);
  }
  return list;
}

async function dispatch({ cmd, args = {} }: Command, client: string): Promise<string> {
  switch (cmd) {
    case 'goto':
      return session.goto(client, String(args.url), { links: !!args.links, outline: !!args.outline, reader: !!args.reader });
    case 'snapshot':
      return session.snapshot(client, {
        diff: !!args.diff,
        links: !!args.links,
        outline: !!args.outline,
        section: args.section ? String(args.section) : '',
        reader: !!args.reader,
      });
    case 'click':
      if (args.newTab) return session.openInNewTab(client, ref(args.ref));
      return session.click(client, ref(args.ref));
    case 'type':
      return session.type(client, ref(args.ref), String(args.text ?? ''), !!args.submit);
    case 'fill':
      return session.fill(client, fields(args.fields), !!args.submit);
    case 'drag': {
      const to = args.to;
      if (to === undefined || to === '') throw new Error('drag needs a target: a ref, or text on the drop zone');
      return session.drag(client, ref(args.from), /^\d+$/.test(String(to)) ? Number(to) : String(to));
    }
    case 'select':
      return session.select(client, ref(args.ref), String(args.option ?? ''));
    case 'press':
      return session.press(client, String(args.key ?? ''));
    case 'scroll':
      return session.scroll(client, String(args.to ?? 'down'));
    case 'hover':
      return session.hover(client, ref(args.ref));
    case 'tabs':
      return args.json ? JSON.stringify(await session.tabEntries()) : session.tabList();
    case 'newtab':
      return session.newTab(client, args.url ? String(args.url) : undefined);
    case 'tab':
      return session.switchTab(client, tab(args.n));
    case 'close-tab':
      return session.closeTab(client, args.n === undefined ? undefined : tab(args.n));
    case 'reload':
      return session.reload(client, !!args.hard, !!args.diff);
    case 'upload':
      return session.upload(client, ref(args.ref), files(args.files));
    case 'back':
      return session.history(client, -1);
    case 'forward':
      return session.history(client, 1);
    case 'wait': {
      const text = args.for ?? args.gone;
      if (text !== undefined && text !== '') {
        return session.waitFor(client, String(text), { gone: args.for === undefined, seconds: Math.min(Number(args.seconds) || 10, 60) });
      }
      return session.wait(client, Math.min(Number(args.seconds) || 2, 60), !!args.diff);
    }
    case 'expect':
      return session.expect(client, checksOf(args), Math.min(Number(args.seconds) || 5, 60));
    case 'audit':
      return session.audit(client, { json: !!args.json });
    case 'inspect':
      return session.inspect(client, ref(args.ref), {
        json: !!args.json,
        shot: !!args.shot,
        css: Array.isArray(args.css) ? args.css.map(String).slice(0, 40) : [],
      });
    case 'bundle':
      return bundle(args, client);
    case 'record':
      return record(String(args.action ?? 'status'), args.file === undefined ? undefined : String(args.file));
    case 'dialog':
      if (args.action !== 'accept' && args.action !== 'dismiss') throw new Error('dialog needs accept or dismiss');
      return session.answer(client, args.action === 'accept', args.text === undefined ? undefined : String(args.text));
    case 'pictures': {
      // For the terminal UI's advanced grid, which asks for full size when the terminal draws real pixels.
      const scale = typeof args.scale === 'number' && args.scale > 0 && args.scale <= 2 ? args.scale : undefined;
      const quality = typeof args.quality === 'number' && args.quality >= 1 && args.quality <= 100 ? Math.round(args.quality) : undefined;
      return JSON.stringify(await session.pictures({ scale, quality }));
    }
    case 'screenshot':
      return JSON.stringify(await session.screenshot({ full: !!args.full }));
    case 'downloads':
      return session.downloadList();
    case 'info':
      return args.json ? JSON.stringify(await session.info()) : infoText(await session.info());
    case 'find':
      return session.find(client, String(args.text ?? ''), { context: Math.min(Math.max(0, Number(args.context ?? 1) || 0), 5) });
    case 'console':
      return session.consoleText({ all: !!args.all });
    case 'network':
      return session.networkText({ all: !!args.all });
    case 'extract':
      return session.extractData(client, { kind: args.kind ? String(args.kind) : '', n: Number(args.n) || 1, csv: !!args.csv });
    case 'clear-site-data':
      return session.clearSiteData();
    case 'source': {
      const source = await session.source({ dom: !!args.dom });
      return args.json ? JSON.stringify(source) : source.text;
    }
    case 'history':
      if (args.n !== undefined) return session.historyGo(client, entry(args.n));
      return args.json ? JSON.stringify(await session.historyList()) : session.historyText();
    case 'status':
      return `${await session.status()} · session "${name}", pid ${process.pid}${profile ? ` · profile ${profile}` : ''}`;
    default:
      throw new Error(`unknown command "${cmd}"`);
  }
}

/** A replay's failed step, as the client that replayed tells it (see script.ts bundleFailure); undefined if it tells none. */
function failureOf(value: unknown): Failure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const f = value as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    script: String(f.script ?? 'the script'),
    scriptText: String(f.scriptText ?? ''),
    step: Number(f.step) || 1,
    total: Number(f.total) || 1,
    line: Number(f.line) || 1,
    command: String(f.command ?? ''),
    error: String(f.error ?? ''),
    log: list(f.log),
    rest: list(f.rest),
    vars: list(f.vars),
  };
}

/**
 * Save the page as it is to a folder (a bundle: see bundle.ts): the one
 * named, or one of medley's own, of which only the newest are kept.
 */
async function bundle(args: Record<string, unknown>, client: string): Promise<string> {
  const dir = args.dir === undefined || args.dir === null ? undefined : String(args.dir);
  if (dir !== undefined && !isAbsolute(dir)) throw new Error(`"${dir}" is not an absolute path`);
  const failure = failureOf(args.failure);
  const evidence = await session.evidence(client);
  const note = args.note === undefined || args.note === null ? undefined : String(args.note);
  const text = writeBundle(dir ?? defaultBundleDir(failure?.script || evidence.title || 'page'), evidence, { note, failure });
  if (dir === undefined) pruneBundles();
  return text;
}

/** Start, stop or ask about recording a script (see script.ts). */
async function record(action: string, file?: string): Promise<string> {
  if (action === 'start') {
    if (recording) throw new Error(`already recording, ${recording.count} steps so far, to ${recording.file}; record stop ends it`);
    if (file !== undefined && !isAbsolute(file)) throw new Error(`"${file}" is not an absolute path`);
    recording = new Recording(file ?? defaultScriptFile());
    // A script starts where the page is, so replaying it starts there too.
    const url = await session.currentUrl();
    const from = /^(https?|file):/.test(url) ? stepFor({ cmd: 'goto', args: { url } }, new Map()) : null;
    if (from) recording.add(from);
    else recording.save();
    return `recording to ${recording.file}${from ? `, from ${url}` : ''}: what's done in this session is written down as it's done · record stop ends it`;
  }
  if (action === 'stop') {
    if (!recording) throw new Error('not recording; record start begins');
    const done = recording;
    recording = null;
    done.save();
    const steps = done.count === 1 ? '1 step' : `${done.count} steps`;
    return [`stopped recording: ${steps}, saved to ${done.file}`, '', done.text().trimEnd()].join('\n');
  }
  if (action === 'status') return recording ? `recording: ${recording.count} steps so far, to ${recording.file}` : 'not recording';
  throw new Error('record start [file], record stop or record status');
}

function resetIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdown, IDLE_MS);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  removeSessionInfo(name);
  server.stop(true);
  await session.close().catch(() => {});
  process.exit(0);
}

// A page that moves on by itself (a redirect after a browser check, a meta
// refresh) is news to anyone watching: the terminal UI redraws on it.
// News from outside any command (a page that moves on by itself, a download
// that finishes later) goes to anyone watching: the terminal UI redraws on it.
session.onNews = (cmd, summary) => announce({ client: 'page', cmd, ok: true, summary });

// `code` says which medley this is, so a client started from newer code can
// tell the session is out of date (and lacks newer commands).
writeSessionInfo(name, { pid: process.pid, port: server.port!, token, startedAt: Date.now(), code: codeStamp() });
resetIdle();
session.exited.then(shutdown); // the browser closed or crashed
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`medley session "${name}" listening on 127.0.0.1:${server.port} (pid ${process.pid})`);
