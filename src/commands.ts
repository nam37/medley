// Session commands as typed words ("type 4 hello --submit"), shared by the
// CLI and the terminal UI's command line.

import { resolve } from 'node:path';
import { checksOf, EXPECT_USAGE, STATES } from './checks.ts';

export interface ParsedCommand {
  cmd: string;
  args: Record<string, unknown>;
  start?: boolean; // may start the session if none is running
}

export interface CommandFlags {
  links?: boolean;
  diff?: boolean;
  submit?: boolean;
  hard?: boolean;
  outline?: boolean;
  section?: string;
  for?: string; // wait --for <text>
  gone?: string; // wait --gone <text>
  full?: boolean; // screenshot --full
  newTab?: boolean; // click --new-tab
  dom?: boolean; // source --dom
  reader?: boolean; // goto, search, snapshot --reader
  json?: boolean; // info --json (the CLI's own option)
  all?: boolean; // console --all, network --all
  csv?: boolean; // extract … --csv
  max?: number; // a size limit on page results (the CLI's --max)
  count?: string; // expect --count <n> <text>
  within?: string; // expect … --within <seconds>
  noErrors?: boolean; // expect --no-errors
  checks?: [string, string][]; // expect's other checks, in order: ['url', '/cart'], ['checked', 'checkbox Agree']
  shot?: string; // inspect <ref> --shot <file>
  css?: string; // inspect <ref> --css gap,grid-template-columns
}

const FLAGS = new Set(['--links', '--diff', '--submit', '--hard', '--outline', '--full', '--new-tab', '--dom', '--reader', '--all', '--csv', '--json']);
// Options followed by a value: wait --for "Order placed".
const VALUE_FLAGS = new Set(['--for', '--gone', '--section']);
// expect's own options (see checks.ts): they're options only in an expect, and words anywhere else.
const EXPECT_FLAGS = new Set(['--no-errors']);
const EXPECT_VALUE_FLAGS = new Set(['--count', '--within']);
// inspect's: a file for a picture of the element, and more CSS properties to read.
const INSPECT_VALUE_FLAGS = new Set(['--shot', '--css']);
const NONE = new Set<string>();
/** expect's checks that take a value, and may come several times: --url /cart --checked "checkbox Agree". */
export const CHECK_FLAGS = new Set(['--url', '--title', '--value', ...STATES.map((s) => `--${s}`)]);

export class UsageError extends Error {}

const SCHEME = /^([a-z][a-z0-9+.-]*:\/\/|(about|data|file|view-source):)/i;
const LOCAL = /^(localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i;

/** Add a scheme to a typed address: http:// for localhost and IP addresses, https:// for the rest. */
export function toUrl(address: string): string {
  if (SCHEME.test(address)) return address;
  return LOCAL.test(address) ? `http://${address}` : `https://${address}`;
}

/** Where searches go: MEDLEY_SEARCH, a URL with %s where the words go, or Bing (which answers headless browsers). */
export function searchUrl(words: string): string {
  const engine = process.env.MEDLEY_SEARCH || 'https://www.bing.com/search?q=%s';
  return engine.replace('%s', encodeURIComponent(words.trim()).replace(/%20/g, '+'));
}

/** Whether typed text looks like a web address, rather than a stray word like "q". */
export function looksLikeAddress(text: string): boolean {
  if (/\s/.test(text)) return false;
  return SCHEME.test(text) || LOCAL.test(text) || /^[^/]+\.[^/.]+/.test(text);
}

/** A typed word, and how it was quoted: "…" and '…' as a shell quotes, $'…' with \n-style escapes. */
export interface Word {
  text: string;
  quoted: '' | '"' | "'"; // $'…' counts as '…': both are taken literally
}

const WORD = /\$'((?:[^'\\]|\\.)*)'?|"([^"]*)"?|'([^']*)'?|(\S+)/g;
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0' };

/** Split a typed line into words, as a shell would. */
export function tokenize(line: string): Word[] {
  const words: Word[] = [];
  for (const m of line.matchAll(WORD)) {
    if (m[1] !== undefined) {
      const text = m[1].replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, c: string) => (c.length === 3 ? String.fromCharCode(parseInt(c.slice(1), 16)) : (ESCAPES[c] ?? c)));
      words.push({ text, quoted: "'" });
    } else if (m[2] !== undefined) words.push({ text: m[2], quoted: '"' });
    else if (m[3] !== undefined) words.push({ text: m[3], quoted: "'" });
    else words.push({ text: m[4], quoted: '' });
  }
  return words;
}

/** Split a typed line into words, without saying how they were quoted. */
export function splitWords(line: string): string[] {
  return tokenize(line).map((w) => w.text);
}

/**
 * Pull options (--links, --submit, --for <text>, …) out of a word list, as
 * the command line does. A quoted word is never an option: "--submit" is text.
 */
export function splitFlags(words: (string | Word)[]): { words: string[]; flags: CommandFlags } {
  const flags: Record<string, unknown> = {};
  const rest: string[] = [];
  const key = (w: string) => w.slice(2).replace(/-(\w)/g, (_, c: string) => c.toUpperCase()); // --new-tab → newTab
  const list = words.map((w) => (typeof w === 'string' ? { text: w, quoted: '' } : w));
  const expecting = list[0]?.text === 'expect';
  const own = expecting ? EXPECT_VALUE_FLAGS : list[0]?.text === 'inspect' ? INSPECT_VALUE_FLAGS : NONE;
  const checks: [string, string][] = [];
  for (let i = 0; i < list.length; i++) {
    const { text, quoted } = list[i];
    const more = i + 1 < list.length;
    if (!quoted && (FLAGS.has(text) || (expecting && EXPECT_FLAGS.has(text)))) flags[key(text)] = true;
    else if (!quoted && more && (VALUE_FLAGS.has(text) || own.has(text))) flags[key(text)] = list[++i].text;
    else if (!quoted && more && expecting && CHECK_FLAGS.has(text)) checks.push([text.slice(2), list[++i].text]);
    else rest.push(text);
  }
  if (checks.length) flags.checks = checks;
  return { words: rest, flags: flags as CommandFlags };
}

export function parseCommand([command, ...rest]: string[], flags: CommandFlags = {}): ParsedCommand {
  const need = (n: number, usage: string) => {
    if (rest.length < n) throw new UsageError(`usage: ${usage}`);
  };
  switch (command) {
    case 'goto':
      need(1, 'goto <url>');
      return { cmd: 'goto', args: { url: toUrl(rest[0]), links: flags.links, outline: flags.outline, reader: flags.reader }, start: true };
    case 'search':
      need(1, 'search <words>');
      return { cmd: 'goto', args: { url: searchUrl(rest.join(' ')), links: flags.links, outline: flags.outline }, start: true };
    case 'history':
      return { cmd: 'history', args: { n: rest[0] } };
    case 'snapshot':
      return {
        cmd: 'snapshot',
        args: { diff: flags.diff, links: flags.links, outline: flags.outline, section: flags.section, reader: flags.reader },
      };
    case 'click':
      need(1, 'click <ref or name> [--new-tab]');
      return { cmd: 'click', args: { ref: rest.join(' '), newTab: flags.newTab } }; // a name needs no quotes here
    case 'type':
      need(1, 'type <ref> <text> [--submit]');
      return { cmd: 'type', args: { ref: rest[0], text: rest.slice(1).join(' '), submit: flags.submit } };
    case 'select':
      need(2, 'select <ref> <option>');
      return { cmd: 'select', args: { ref: rest[0], option: rest.slice(1).join(' ') } };
    case 'press':
      need(1, 'press <key>');
      return { cmd: 'press', args: { key: rest[0] } };
    case 'hover':
      need(1, 'hover <ref>');
      return { cmd: 'hover', args: { ref: rest.join(' ') } };
    case 'tabs':
      return { cmd: 'tabs', args: {} };
    case 'newtab':
      return { cmd: 'newtab', args: { url: rest[0] ? toUrl(rest[0]) : undefined }, start: true };
    case 'tab':
      need(1, 'tab <number>');
      return { cmd: 'tab', args: { n: rest[0] } };
    case 'close-tab':
      return { cmd: 'close-tab', args: { n: rest[0] } };
    case 'scroll':
      return { cmd: 'scroll', args: { to: rest.join(' ') || 'down' } };
    case 'reload':
      return { cmd: 'reload', args: { hard: flags.hard, diff: flags.diff } };
    case 'upload':
      need(2, 'upload <ref> <file>...');
      // The session may run in another directory; paths are resolved here.
      return { cmd: 'upload', args: { ref: rest[0], files: rest.slice(1).map((f) => resolve(f)) } };
    case 'back':
    case 'forward':
    case 'downloads':
    case 'clear-site-data':
    case 'status':
    case 'stop':
      return { cmd: command, args: {} };
    case 'info':
      return { cmd: 'info', args: { json: flags.json } };
    case 'find':
      need(1, 'find <text>');
      return { cmd: 'find', args: { text: rest.join(' ') } };
    case 'console':
      return { cmd: 'console', args: { all: flags.all } };
    case 'network':
      return { cmd: 'network', args: { all: flags.all } };
    case 'extract':
      if (rest[0] && rest[0] !== 'table' && rest[0] !== 'items') throw new UsageError('usage: extract [table <n> | items <n>] [--csv]');
      return { cmd: 'extract', args: { kind: rest[0], n: rest[1], csv: flags.csv } };
    case 'ask':
      need(1, 'ask <question> [choice…]');
      return { cmd: 'ask-user', args: { question: rest[0], choices: rest.slice(1) } };
    case 'tell':
      need(1, 'tell <message>');
      return { cmd: 'tell-user', args: { text: rest.join(' ') } };
    case 'source':
      return { cmd: 'source', args: { dom: flags.dom } };
    case 'wait':
      return { cmd: 'wait', args: { seconds: rest[0], for: flags.for, gone: flags.gone, diff: flags.diff } };
    case 'expect': {
      // Several checks in one: the words are text to find (or, with --count, to count), the options the rest.
      const checks: Record<string, unknown>[] = [];
      const text = rest.join(' ');
      if (flags.gone !== undefined) checks.push({ kind: 'text', text: flags.gone, gone: true });
      if (flags.count !== undefined) checks.push({ kind: 'count', text, n: flags.count });
      else if (text) checks.push({ kind: 'text', text });
      for (const [name, value] of flags.checks ?? []) {
        if (name === 'url' || name === 'title') checks.push({ kind: name, text: value });
        else if (name === 'value') {
          const at = value.indexOf('=');
          if (at < 1) throw new UsageError(`"${value}" isn't field=value\n${EXPECT_USAGE}`);
          checks.push({ kind: 'value', ref: value.slice(0, at), text: value.slice(at + 1) });
        } else checks.push({ kind: 'state', ref: value, state: name });
      }
      if (flags.noErrors) checks.push({ kind: 'errors' });
      const seconds = flags.within === undefined ? undefined : Number(flags.within);
      if (seconds !== undefined && !(seconds > 0)) throw new UsageError(`"${flags.within}" isn't a number of seconds\n${EXPECT_USAGE}`);
      try {
        return { cmd: 'expect', args: { checks: checksOf({ checks }), ...(seconds ? { seconds } : {}) } };
      } catch (e) {
        throw new UsageError((e as Error).message);
      }
    }
    case 'audit':
      return { cmd: 'audit', args: { json: flags.json } };
    case 'inspect': {
      need(1, 'inspect <ref or name> [--shot <file>] [--css <property,…>] [--json]');
      const css = flags.css?.split(',').map((p) => p.trim()).filter(Boolean);
      // The picture is saved by whoever asked, where they are (the session may run elsewhere).
      return { cmd: 'inspect', args: { ref: rest.join(' '), json: flags.json, shot: flags.shot !== undefined, path: flags.shot, css } };
    }
    case 'record': {
      const action = rest[0] ?? 'status';
      if (action === 'start') return { cmd: 'record', args: { action, file: rest[1] ? resolve(rest[1]) : undefined } };
      if (action === 'stop' || action === 'status') return { cmd: 'record', args: { action } };
      throw new UsageError('usage: record start [file] | record stop | record status');
    }
    case 'replay':
    case 'playwright':
    case 'watch':
      throw new UsageError(`${command} runs from a shell: medley ${command} …`);
    case 'fill': {
      need(1, 'fill <ref>=<value>... [--submit]');
      const fields = rest.map((w) => {
        const at = w.indexOf('=');
        if (at < 1) throw new UsageError(`"${w}" isn't ref=value; usage: fill <ref>=<value>... [--submit]`);
        return { ref: w.slice(0, at), value: w.slice(at + 1) };
      });
      return { cmd: 'fill', args: { fields, submit: flags.submit } };
    }
    case 'screenshot':
      return { cmd: 'screenshot', args: { full: flags.full, path: rest[0] } };
    case 'drag':
      need(2, 'drag <ref> <ref, or text on the drop zone>');
      return { cmd: 'drag', args: { from: rest[0], to: rest.slice(1).join(' ') } };
    case 'dialog':
      if (rest[0] !== 'accept' && rest[0] !== 'dismiss') throw new UsageError('usage: dialog accept [text] | dialog dismiss');
      return { cmd: 'dialog', args: { action: rest[0], text: rest.length > 1 ? rest.slice(1).join(' ') : undefined } };
    default:
      throw new UsageError(command ? `unknown command "${command}"` : 'no command given');
  }
}
