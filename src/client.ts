// Finds (or starts) the session daemon and sends it commands. The daemon
// writes ~/.medley/<name>.json with its port and a random token; only this
// user can read it, and every request has to carry the token.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './browser.ts';
import type { View } from './session.ts';
import type { TalkEvent } from './talk.ts';

export interface Command {
  cmd: string;
  args?: Record<string, unknown>;
  client?: string;
  state?: boolean; // also return the page structure (see Session.view)
}

export interface Reply {
  text: string;
  state?: View;
  messages?: string[]; // what the person watching said, for an agent (see talk.ts): "says: …"
}

/** Announced on /events after every command, whoever sent it, and for what's said (talk). */
export interface SessionEvent {
  client: string;
  cmd: string;
  ok: boolean;
  summary: string;
  talk?: TalkEvent;
  refs?: number[]; // the elements the command acts on, for showing where a client is at
  starting?: boolean; // announced as the command begins, rather than when it's done
}

/** A command that failed, with anything the person watching said meanwhile. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly messages: string[] = [],
  ) {
    super(message);
  }
}

/** Messages from the person watching, as lines to put before a result on a terminal. */
export function messageLines(messages: string[] = []): string[] {
  return messages.map((m) => `your user (watching in medley's terminal UI) ${m}`);
}

export interface SessionInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
  code?: string; // see codeStamp; missing from sessions started before it existed
}

export interface StartOptions {
  headed?: boolean;
  browser?: string;
  width?: number;
  profile?: string; // a browser profile directory to keep between sessions
  downloads?: string; // where downloads go
}

const DIR = join(homedir(), '.medley');
const infoFile = (name: string) => join(DIR, `${name}.json`);
export const logFile = (name: string) => join(DIR, `${name}.log`);

export function readSessionInfo(name: string): SessionInfo | null {
  try {
    return JSON.parse(readFileSync(infoFile(name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeSessionInfo(name: string, info: SessionInfo) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${infoFile(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, infoFile(name)); // readers never see a half-written file
}

export function removeSessionInfo(name: string) {
  rmSync(infoFile(name), { force: true });
}

let stamp: string | undefined;

/** A short hash of medley's own source, so a session started by other (older) code can be told apart. */
export function codeStamp(): string {
  if (stamp) return stamp;
  const hash = createHash('sha1');
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|js)$/.test(entry.name)) hash.update(entry.name).update(readFileSync(path));
    }
  };
  walk(fileURLToPath(new URL('.', import.meta.url)));
  return (stamp = hash.digest('hex').slice(0, 12));
}

/** Whether the named session is running code other than this medley's (so it may lack newer commands). */
export function sessionIsStale(name: string): boolean {
  const info = readSessionInfo(name);
  return !!info && info.code !== codeStamp();
}

/** What to say when a session doesn't know a command: it was started by an older medley. */
export const STALE_HINT = 'this session was started by an older medley; restart it to use newer commands';

class Unreachable extends Error {}

/**
 * Send a command to the named session. With `start`, a session that isn't
 * running is started first; without it, that's an error.
 */
export async function request(name: string, command: Command, start?: StartOptions): Promise<Reply> {
  const info = readSessionInfo(name);
  if (info) {
    try {
      return await post(info, command);
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      removeSessionInfo(name); // left behind by a daemon that died
    }
  }
  const pending = starting.get(name);
  if (pending) return post(await pending, command); // being started already (see prewarm)
  if (!start) {
    const which = name === 'default' ? '' : ` "${name}"`;
    throw new Error(`no browser session${which} is running; start one with: medley goto <url>`);
  }
  return post(await startOnce(name, start), command);
}

// Sessions this process is starting, so a second request waits for the same one.
const starting = new Map<string, Promise<SessionInfo>>();

function startOnce(name: string, opts: StartOptions): Promise<SessionInfo> {
  let p = starting.get(name);
  if (!p) {
    p = startDaemon(name, opts).finally(() => starting.delete(name));
    starting.set(name, p);
  }
  return p;
}

/**
 * Start the named session in the background if none is running, so the
 * browser (which takes a second or two to start) is ready by the time the
 * first page is asked for. Resolves once it's up; never rejects.
 */
export async function prewarm(name: string, opts: StartOptions): Promise<void> {
  if (readSessionInfo(name)) return;
  await startOnce(name, opts).catch(() => {});
}

/** A command's result as text, after anything the person watching said. */
export async function send(name: string, command: Command, start?: StartOptions): Promise<string> {
  try {
    const reply = await request(name, command, start);
    const said = messageLines(reply.messages);
    return said.length ? [...said, '', reply.text].join('\n') : reply.text;
  } catch (e) {
    if (e instanceof CommandError && e.messages.length) throw new Error([...messageLines(e.messages), '', e.message].join('\n'));
    throw e;
  }
}

/**
 * Follow the session's events until `signal` aborts, reconnecting whenever
 * the session goes away and a new one starts. `onConnection` reports whether
 * a session is currently being followed.
 */
export async function watch(
  name: string,
  onEvent: (e: SessionEvent) => void,
  signal: AbortSignal,
  onConnection: (connected: boolean) => void = () => {},
) {
  while (!signal.aborted) {
    const info = readSessionInfo(name);
    if (info) {
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/events`, {
          headers: { 'x-medley-token': info.token },
          signal,
        });
        if (res.ok && res.body) {
          onConnection(true);
          let buffered = '';
          const decoder = new TextDecoder();
          for await (const chunk of res.body) {
            buffered += decoder.decode(chunk, { stream: true });
            let end: number;
            while ((end = buffered.indexOf('\n\n')) >= 0) {
              const message = buffered.slice(0, end);
              buffered = buffered.slice(end + 2);
              if (message.startsWith('data: ')) onEvent(JSON.parse(message.slice(6)));
            }
          }
        }
      } catch {
        // the session went away, or we were aborted
      }
      onConnection(false);
    }
    await sleep(1000);
  }
}

async function post(info: SessionInfo, command: Command): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-medley-token': info.token },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error('the session did not answer in time');
    throw new Unreachable();
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: boolean; text?: string; error?: string; state?: View; messages?: string[] }
    | null;
  if (!body) throw new Error(`the session answered with HTTP ${res.status}`);
  if (!body.ok) throw new CommandError(body.error ?? 'failed', body.messages);
  return { text: body.text ?? '', state: body.state, messages: body.messages };
}

async function startDaemon(name: string, opts: StartOptions): Promise<SessionInfo> {
  mkdirSync(DIR, { recursive: true });
  removeSessionInfo(name);
  const args = [fileURLToPath(new URL('./daemon.ts', import.meta.url)), '--name', name];
  if (opts.headed) args.push('--headed');
  if (opts.browser) args.push('--browser', opts.browser);
  if (opts.width) args.push('--width', String(opts.width));
  if (opts.profile) args.push('--profile', opts.profile);
  if (opts.downloads) args.push('--downloads', opts.downloads);
  // The log gets a line per command; start it over once it passes a megabyte.
  let size = 0;
  try {
    size = statSync(logFile(name)).size;
  } catch {}
  const log = openSync(logFile(name), size > 1_000_000 ? 'w' : 'a');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  closeSync(log);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = readSessionInfo(name);
    if (info) return info;
    if (child.exitCode !== null) {
      // The daemon's last error says why (a browser that won't start, a profile in use).
      let why = '';
      try {
        why = readFileSync(logFile(name), 'utf8').match(/^error: (.*)$/gm)?.pop()?.slice(7) ?? '';
      } catch {}
      throw new Error(`the session failed to start${why ? `: ${why}` : ''}; see ${logFile(name)}`);
    }
    await sleep(25); // the browser takes a second or two; don't add to it
  }
  throw new Error(`timed out starting the session; see ${logFile(name)}`);
}

/**
 * Save a `screenshot` reply's PNG, to `path` or a timestamped name in the
 * current directory; returns what to tell the user.
 */
export function saveScreenshot(reply: string, path?: string): string {
  const shot = JSON.parse(reply) as { png: string; width: number; height: number; url: string };
  const file = resolve(path || `screenshot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  writeFileSync(file, Buffer.from(shot.png, 'base64'));
  return `saved a ${shot.width}×${shot.height} screenshot of ${shot.url || 'the page'} to ${file}`;
}
