// Session commands as typed words ("type 4 hello --submit"), shared by the
// CLI and the terminal UI's command line.

import { resolve } from 'node:path';

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
}

const FLAGS = new Set(['--links', '--diff', '--submit', '--hard']);

export class UsageError extends Error {}

const SCHEME = /^([a-z][a-z0-9+.-]*:\/\/|(about|data|file|view-source):)/i;
const LOCAL = /^(localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i;

/** Add a scheme to a typed address: http:// for localhost and IP addresses, https:// for the rest. */
export function toUrl(address: string): string {
  if (SCHEME.test(address)) return address;
  return LOCAL.test(address) ? `http://${address}` : `https://${address}`;
}

/** Whether typed text looks like a web address, rather than a stray word like "q". */
export function looksLikeAddress(text: string): boolean {
  if (/\s/.test(text)) return false;
  return SCHEME.test(text) || LOCAL.test(text) || /^[^/]+\.[^/.]+/.test(text);
}

/** Split a typed line into words, as a shell would for "quoted words" and 'quoted words'. */
export function splitWords(line: string): string[] {
  const words: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"?|'([^']*)'?|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/** Pull --links, --diff, --submit and --hard out of a word list. */
export function splitFlags(words: string[]): { words: string[]; flags: CommandFlags } {
  const flags: CommandFlags = {};
  const rest = words.filter((w) => {
    if (FLAGS.has(w)) {
      flags[w.slice(2) as keyof CommandFlags] = true;
      return false;
    }
    return true;
  });
  return { words: rest, flags };
}

export function parseCommand([command, ...rest]: string[], flags: CommandFlags = {}): ParsedCommand {
  const need = (n: number, usage: string) => {
    if (rest.length < n) throw new UsageError(`usage: ${usage}`);
  };
  switch (command) {
    case 'goto':
      need(1, 'goto <url>');
      return { cmd: 'goto', args: { url: toUrl(rest[0]), links: flags.links }, start: true };
    case 'snapshot':
      return { cmd: 'snapshot', args: { diff: flags.diff, links: flags.links } };
    case 'click':
      need(1, 'click <ref>');
      return { cmd: 'click', args: { ref: rest[0] } };
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
      return { cmd: 'hover', args: { ref: rest[0] } };
    case 'tabs':
      return { cmd: 'tabs', args: {} };
    case 'tab':
      need(1, 'tab <number>');
      return { cmd: 'tab', args: { n: rest[0] } };
    case 'close-tab':
      return { cmd: 'close-tab', args: { n: rest[0] } };
    case 'scroll':
      return { cmd: 'scroll', args: { to: rest[0] ?? 'down' } };
    case 'reload':
      return { cmd: 'reload', args: { hard: flags.hard } };
    case 'upload':
      need(2, 'upload <ref> <file>...');
      // The session may run in another directory; paths are resolved here.
      return { cmd: 'upload', args: { ref: rest[0], files: rest.slice(1).map((f) => resolve(f)) } };
    case 'back':
    case 'forward':
    case 'status':
    case 'stop':
      return { cmd: command, args: {} };
    case 'wait':
      return { cmd: 'wait', args: { seconds: rest[0] ?? 2 } };
    case 'dialog':
      if (rest[0] !== 'accept' && rest[0] !== 'dismiss') throw new UsageError('usage: dialog accept [text] | dialog dismiss');
      return { cmd: 'dialog', args: { action: rest[0], text: rest.length > 1 ? rest.slice(1).join(' ') : undefined } };
    default:
      throw new UsageError(command ? `unknown command "${command}"` : 'no command given');
  }
}
