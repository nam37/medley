// Owns one browser session and serves commands from local clients (the CLI,
// the MCP server, the terminal UI) over HTTP on 127.0.0.1. Commands run one at
// a time, and every finished command is announced on /events so a watching
// client can follow along. Exits when told to stop, when the browser goes
// away, or after 30 idle minutes. Started by client.ts; not meant to be run by hand.

import { randomUUID } from 'node:crypto';
import { removeSessionInfo, writeSessionInfo, type Command, type SessionEvent } from './client.ts';
import { Session } from './session.ts';

const IDLE_MS = 30 * 60_000;
const HEARTBEAT_MS = 20_000; // keeps idle event streams open

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = flag('--name') ?? 'default';

const session = await Session.start({
  headless: !argv.includes('--headed'),
  executable: flag('--browser'),
  width: Number(flag('--width')) || undefined,
});
const token = randomUUID();
const watchers = new Set<(chunk: string) => void>();
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;

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
    const run = queue.then(() => dispatch(command, client));
    queue = run.catch(() => {});
    try {
      const text = await run;
      announce({ client, cmd: command.cmd, ok: true, summary: summarize(command, text) });
      return Response.json({ ok: true, text, state: command.state ? session.view(client) : undefined });
    } catch (e) {
      const error = (e as Error).message;
      announce({ client, cmd: command.cmd, ok: false, summary: `${command.cmd} failed: ${error.split('\n')[0]}` });
      return Response.json({ ok: false, error });
    } finally {
      if (command.cmd === 'stop') setTimeout(shutdown, 50);
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
      req.signal.addEventListener('abort', stop);
    },
    cancel: stop,
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

function announce(event: SessionEvent) {
  const chunk = `data: ${JSON.stringify(event)}\n\n`;
  for (const send of watchers) send(chunk);
}

function summarize({ cmd, args }: Command, text: string): string {
  if (cmd === 'goto') return `opened ${args?.url}`;
  if (cmd === 'snapshot') return 'looked at the page';
  if (cmd === 'screenshot') return 'took a screenshot';
  if (cmd === 'tabs') return 'listed the tabs';
  return text.split('\n')[0];
}

function ref(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a ref; refs are the numbers in a snapshot`);
  return n;
}

function tab(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`"${value}" is not a tab number; tabs lists them`);
  return n;
}

async function dispatch({ cmd, args = {} }: Command, client: string): Promise<string> {
  switch (cmd) {
    case 'goto':
      return session.goto(client, String(args.url), { links: !!args.links });
    case 'snapshot':
      return session.snapshot(client, { diff: !!args.diff, links: !!args.links });
    case 'click':
      return session.click(client, ref(args.ref));
    case 'type':
      return session.type(client, ref(args.ref), String(args.text ?? ''), !!args.submit);
    case 'select':
      return session.select(client, ref(args.ref), String(args.option ?? ''));
    case 'press':
      return session.press(client, String(args.key ?? ''));
    case 'scroll':
      return session.scroll(client, String(args.to ?? 'down'));
    case 'hover':
      return session.hover(client, ref(args.ref));
    case 'tabs':
      return session.tabList();
    case 'tab':
      return session.switchTab(client, tab(args.n));
    case 'close-tab':
      return session.closeTab(client, args.n === undefined ? undefined : tab(args.n));
    case 'back':
      return session.history(client, -1);
    case 'forward':
      return session.history(client, 1);
    case 'wait':
      return session.wait(client, Math.min(Number(args.seconds) || 2, 60));
    case 'dialog':
      if (args.action !== 'accept' && args.action !== 'dismiss') throw new Error('dialog needs accept or dismiss');
      return session.answer(client, args.action === 'accept', args.text === undefined ? undefined : String(args.text));
    case 'screenshot':
      return JSON.stringify(await session.screenshot()); // for the terminal UI's pictures
    case 'status':
      return `${await session.status()} · session "${name}", pid ${process.pid}`;
    case 'stop':
      return `stopped session "${name}"`;
    default:
      throw new Error(`unknown command "${cmd}"`);
  }
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

writeSessionInfo(name, { pid: process.pid, port: server.port!, token, startedAt: Date.now() });
resetIdle();
session.exited.then(shutdown); // the browser closed or crashed
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`medley session "${name}" listening on 127.0.0.1:${server.port} (pid ${process.pid})`);
