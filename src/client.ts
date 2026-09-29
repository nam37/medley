// Finds (or starts) the session daemon and sends it commands. The daemon
// writes ~/.medley/<name>.json with its port and a random token; only this
// user can read it, and every request has to carry the token.

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './browser.ts';
import type { View } from './session.ts';

export interface Command {
  cmd: string;
  args?: Record<string, unknown>;
  client?: string;
  state?: boolean; // also return the page structure (see Session.view)
}

export interface Reply {
  text: string;
  state?: View;
}

/** Announced on /events after every command, whoever sent it. */
export interface SessionEvent {
  client: string;
  cmd: string;
  ok: boolean;
  summary: string;
}

export interface SessionInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

export interface StartOptions {
  headed?: boolean;
  browser?: string;
  width?: number;
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
  if (!start) {
    const which = name === 'default' ? '' : ` "${name}"`;
    throw new Error(`no browser session${which} is running; start one with: medley goto <url>`);
  }
  return post(await startDaemon(name, start), command);
}

export async function send(name: string, command: Command, start?: StartOptions): Promise<string> {
  return (await request(name, command, start)).text;
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
  const body = (await res.json().catch(() => null)) as { ok: boolean; text?: string; error?: string; state?: View } | null;
  if (!body) throw new Error(`the session answered with HTTP ${res.status}`);
  if (!body.ok) throw new Error(body.error);
  return { text: body.text ?? '', state: body.state };
}

async function startDaemon(name: string, opts: StartOptions): Promise<SessionInfo> {
  mkdirSync(DIR, { recursive: true });
  removeSessionInfo(name);
  const args = [fileURLToPath(new URL('./daemon.ts', import.meta.url)), '--name', name];
  if (opts.headed) args.push('--headed');
  if (opts.browser) args.push('--browser', opts.browser);
  if (opts.width) args.push('--width', String(opts.width));
  const log = openSync(logFile(name), 'a');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  child.unref();
  closeSync(log);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = readSessionInfo(name);
    if (info) return info;
    if (child.exitCode !== null) throw new Error(`the session failed to start; see ${logFile(name)}`);
    await sleep(100);
  }
  throw new Error(`timed out starting the session; see ${logFile(name)}`);
}
