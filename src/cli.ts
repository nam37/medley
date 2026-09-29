#!/usr/bin/env bun
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { send, STALE_HINT } from './client.ts';
import { colorize } from './color.ts';
import { parseCommand, toUrl, UsageError } from './commands.ts';
import { serveMcp } from './mcp.ts';
import { Session } from './session.ts';

const USAGE = `usage: medley <command> [args] [options]

Browse the web as text. A session keeps one browser open between commands.
Every interactive element in a snapshot has a number (a ref) that actions use,
and each action prints only what changed.

session commands:
  goto <url>                      open a page (starts the session if needed)
  search <words>                  search the web (Bing, or MEDLEY_SEARCH: a URL with %s for the words)
  snapshot [--diff]               print the current page (--diff: only what changed since you last looked)
  click <ref>
  type <ref> <text> [--submit]    replace a field's text (--submit: then press Enter)
  select <ref> <option>           choose an option of a <select> by its text or value
  press <key>                     Enter, Escape, Tab, ArrowDown, PageDown, a, Control+a, ...
  hover <ref>                     move the mouse over an element (menus that open on hover)
  scroll [down|up|top|bottom|<ref>]
  upload <ref> <file>...          choose files for a file field, as if picked in its dialog
  reload [--hard]                 reload the page (--hard: bypass the cache)
  back, forward
  history [n]                     list this tab's pages, or go to the n-th
  downloads                       list what this session downloaded, and where
  tabs                            list open tabs (links can open new ones)
  tab <number>                    switch to a tab
  close-tab [number]              close a tab (the current one by default)
  wait [seconds]                  let the page work, then show what changed (default 2)
  dialog accept [text]            answer a confirm() or prompt() the page opened
  dialog dismiss
  status, stop

other commands:
  tui [url]                       browse the session in a full-screen terminal UI
  snapshot <url> [--json]         one-off: open the page in a fresh browser, print it, exit
                                  (--json: print the raw page model instead)
  mcp                             run as an MCP server on stdio, sharing the session

options:
  --session <name>   use a named session (default: "default", or MEDLEY_SESSION)
  --profile <name>   start the session with a kept browser profile, so logins and
                     cookies last between sessions (or MEDLEY_PROFILE); one
                     session at a time can use a profile
  --downloads <dir>  where the session saves downloads (default ~/Downloads/medley)
  --headed           start the session with a visible browser window
  --links            list link targets after a full snapshot
  --color, --no-color  force ANSI color on or off (default: on for terminals)
  --width <px>       viewport width when starting a browser (default 1280)
  --browser <path>   Chrome/Edge executable (or MEDLEY_BROWSER)
`;

// A reader that stops early (| head) closes the pipe; that's not an error.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

function fail(msg: string, code = 1): never {
  process.stderr.write(`medley: ${msg}\n`);
  process.exit(code);
}

const opts = {
  session: process.env.MEDLEY_SESSION || 'default',
  headed: false,
  links: false,
  diff: false,
  submit: false,
  hard: false,
  json: false,
  color:!!process.stdout.isTTY && !process.env.NO_COLOR,
  width: undefined as number | undefined,
  browser: undefined as string | undefined,
  profile: process.env.MEDLEY_PROFILE || undefined,
  downloads: undefined as string | undefined,
};
const words: string[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => argv[++i] ?? fail(`${a} needs a value`);
  if (a === '--session') opts.session = value();
  else if (a === '--headed') opts.headed = true;
  else if (a === '--links') opts.links = true;
  else if (a === '--diff') opts.diff = true;
  else if (a === '--submit') opts.submit = true;
  else if (a === '--hard') opts.hard = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--color') opts.color = true;
  else if (a === '--no-color') opts.color = false;
  else if (a === '--width') opts.width = Number(value()) || fail('--width must be a number');
  else if (a === '--browser') opts.browser = value();
  else if (a === '--profile') opts.profile = value();
  else if (a === '--downloads') opts.downloads = resolve(value());
  else if (a === '-h' || a === '--help') {
    process.stdout.write(USAGE);
    process.exit(0);
  } else if (a.startsWith('--')) fail(`unknown option ${a}\n\n${USAGE}`, 2);
  else words.push(a);
}
if (!/^[\w-]+$/.test(opts.session)) fail('session names may use letters, digits, - and _');
if (opts.profile && !/^[\w-]+$/.test(opts.profile)) fail('profile names may use letters, digits, - and _');
const profileDir = opts.profile ? join(homedir(), '.medley', 'profiles', opts.profile) : undefined;

const [command, ...rest] = words;
const client = process.env.MEDLEY_CLIENT || 'cli';
const start = { headed: opts.headed, browser: opts.browser, width: opts.width, profile: profileDir, downloads: opts.downloads };

async function oneShot(url: string) {
  const session = await Session.start({
    executable: opts.browser,
    width: opts.width,
    headless: !opts.headed,
    profile: profileDir,
    downloads: opts.downloads,
  });
  process.on('SIGINT', () => process.exit(130));
  try {
    const text = await session.goto('one-shot', toUrl(url), { links: opts.links });
    return opts.json ? JSON.stringify(await session.model(), null, 1) : text;
  } finally {
    await session.close();
  }
}

async function run(): Promise<string> {
  if (command === 'snapshot' && rest[0]) return oneShot(rest[0]);
  const { cmd, args, start: starts } = parseCommand(words, opts);
  const reply = send(opts.session, { cmd, args, client }, starts ? start : undefined);
  if (cmd !== 'stop') return reply;
  return reply.catch((e: Error) => (e.message.startsWith('no browser session') ? 'no session was running' : Promise.reject(e)));
}

if (!command) {
  process.stderr.write(USAGE);
  process.exit(2);
} else if (command === 'mcp') {
  await serveMcp(opts.session, start);
} else if (command === 'tui') {
  // Loaded only here, so other commands don't pay for OpenTUI's native library.
  const { runTui } = await import('./tui/main.ts');
  await runTui({ session: opts.session, start, url: rest[0] ? toUrl(rest[0]) : undefined });
} else {
  try {
    const text = await run();
    process.stdout.write((opts.color && !opts.json ? colorize(text) : text) + '\n');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
    if (e instanceof UsageError) fail(`${e.message}\n\n${USAGE}`, 2);
    const message = (e as Error).message;
    // parseCommand knew the command, so it's the session that's behind.
    if (message.startsWith('unknown command')) fail(`${message}: ${STALE_HINT} (medley stop, then run it again)`);
    fail(message);
  }
}
