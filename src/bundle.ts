// Bundles: what the page was at some moment, saved as a folder of files, to
// look at later or to hand to someone else, or to an agent: its text as
// medley shows it, a picture of it, its HTML, everything it logged and every
// request it made, and a README.md that says what's there. When a replayed
// script's step fails, a bundle is made of that moment, with the step, what
// went wrong, and the steps that led there, so the failure can be looked into
// after the page has moved on, and run again.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What the page was (see Session.evidence): each part that couldn't be had is named in `missing`, with why. */
export interface Evidence {
  at: string; // when, as an ISO time
  url: string;
  title: string;
  window: { w: number; h: number };
  tabs: string; // "tab 1 of 2"
  dialog?: string; // a confirm() or prompt() that was open, blocking the page
  page?: string; // the page as medley shows it, with its links' addresses
  html?: string; // its HTML as it was, after its scripts ran
  screenshot?: string; // the window, a PNG in base64
  whole?: string; // the whole page, when it's taller than the window
  console: string; // every message, as `console --all` tells them
  network: string; // every request, as `network --all` does
  messages: number;
  requests: number;
  errors: string[]; // the errors it logged
  warnings: number;
  failed: string[]; // its requests that failed
  missing: string[];
}

/** A replayed step that failed, and how the replay got there. */
export interface Failure {
  script: string; // the script's name
  scriptText: string;
  step: number; // which step failed, from 1
  total: number;
  line: number; // its line in the script
  command: string;
  error: string;
  log: string[]; // the steps done, as replay printed them
  rest: string[]; // the steps not run
  vars: string[]; // what the script reads from the environment
}

/** Where bundles go when no folder is named. */
export const BUNDLES = join(homedir(), '.medley', 'bundles');
// How many of them are kept there: the oldest beyond this make room for new ones.
const KEPT = 30;
const OWN_NAME = /^\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d-[\w-]*$/;

const two = (n: number) => String(n).padStart(2, '0');
const local = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

/** ~/.medley/bundles/<when>-<name>, the name made of what's safe in a file name. */
export function defaultBundleDir(name: string, when = new Date()): string {
  const slug = name.toLowerCase().replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
  return join(BUNDLES, `${local(when).replace(/[ :]/g, '-')}-${slug}`);
}

/** Make room in medley's own folder of bundles: the oldest it named itself, beyond the newest KEPT, go. How many went. */
export function pruneBundles(dir = BUNDLES, kept = KEPT): number {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => OWN_NAME.test(n)).sort();
  } catch {
    return 0;
  }
  const old = names.slice(0, Math.max(0, names.length - kept));
  for (const n of old) rmSync(join(dir, n), { recursive: true, force: true });
  return old.length;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const indent = (lines: string[]) => lines.map((l) => `    ${l}`);

/** The bundle's README.md: what it's of, what went wrong, and what's in the folder. */
function readme(e: Evidence, files: [string, string][], note?: string, f?: Failure): string {
  const when = local(new Date(e.at));
  const page = `**${e.title || '(untitled)'}** · ${e.url || '(no address)'} · window ${e.window.w}×${e.window.h} · ${e.tabs}`;
  const out: string[] = [];
  if (f) {
    out.push(`# A step failed: ${f.command}`, '');
    out.push(`Step ${f.step} of ${f.total} of ${f.script} (line ${f.line}) failed, at ${when}:`, '');
    out.push(...indent([f.command, '', ...f.error.split('\n')]), '');
    out.push(`The page then: ${page}`);
  } else {
    out.push(`# The page, as it was at ${when}`, '', page);
  }
  if (note) out.push('', note);
  if (e.dialog) out.push('', `A dialog was open on the page: ${e.dialog}`);
  if (e.missing.length) out.push('', 'Not everything could be saved:', '', ...e.missing.map((m) => `- ${m}`));

  if (f) {
    out.push('', '## Steps', '', ...indent(f.log), ...indent(f.rest.map((s, i) => `· ${f.step + i + 1} ${s} (not run)`)), '');
    const reads = f.vars.length ? ` (it reads ${f.vars.join(', ')} from the environment)` : '';
    out.push(`To run them again: \`medley replay steps.medley\`${reads}.`);
  }

  out.push('', '## What the page logged', '');
  if (!e.errors.length) out.push(`No errors${e.warnings ? `, ${plural(e.warnings, 'warning')}` : ''} (${plural(e.messages, 'message')} in console.txt).`);
  else {
    out.push(`${plural(e.errors.length, 'error')}${e.warnings ? `, ${plural(e.warnings, 'warning')}` : ''} (console.txt has all ${plural(e.messages, 'message')}):`, '');
    out.push(...indent(e.errors.slice(0, 20)), ...(e.errors.length > 20 ? indent([`… and ${e.errors.length - 20} more`]) : []));
  }
  out.push('', '## Requests that failed', '');
  if (!e.failed.length) out.push(`None of ${plural(e.requests, 'request')} (network.txt has them).`);
  else {
    out.push(`${e.failed.length} of ${plural(e.requests, 'request')} (network.txt has them all):`, '');
    out.push(...indent(e.failed.slice(0, 20)), ...(e.failed.length > 20 ? indent([`… and ${e.failed.length - 20} more`]) : []));
  }

  out.push('', '## In this folder', '', ...files.map(([name, what]) => `- \`${name}\`: ${what}`));
  out.push('', 'A bundle holds what the page showed, what was in its fields and the addresses it asked for included: look through it before passing it on.', '');
  return out.join('\n');
}

/**
 * Write a bundle to `dir` (made if need be): the README, then a file for each
 * part there is. Returns what to say of it: where it went, and what's in it.
 */
export function writeBundle(dir: string, e: Evidence, about: { note?: string; failure?: Failure } = {}): string {
  mkdirSync(dir, { recursive: true });
  const f = about.failure;
  const files: [string, string][] = [];
  const put = (name: string, content: string | Buffer | undefined, what: string) => {
    if (content === undefined) return;
    writeFileSync(join(dir, name), content);
    files.push([name, what]);
  };
  put('page.txt', e.page, 'the page as medley shows it: its text, with every control numbered');
  put('screenshot.png', e.screenshot === undefined ? undefined : Buffer.from(e.screenshot, 'base64'), `the window as it looked (${e.window.w}×${e.window.h})`);
  put('page.png', e.whole === undefined ? undefined : Buffer.from(e.whole, 'base64'), 'the whole page, top to bottom');
  put('page.html', e.html, "the page's HTML as it was, after its scripts ran");
  put('console.txt', e.console, `everything the page logged: ${plural(e.messages, 'message')}, ${plural(e.errors.length, 'error')}`);
  put('network.txt', e.network, `every request it made: ${plural(e.requests, 'request')}, ${e.failed.length} failed`);
  if (f) put('steps.medley', f.scriptText, 'the script that was replayed');
  const { page: _page, html: _html, screenshot: _shot, whole: _whole, console: _console, network: _network, ...facts } = e;
  const data = { ...facts, ...(about.note ? { note: about.note } : {}), ...(f ? { failure: { ...f, scriptText: undefined } } : {}), files: ['README.md', ...files.map(([n]) => n), 'bundle.json'] };
  put('bundle.json', JSON.stringify(data, null, 1), `${f ? 'what failed and ' : ''}what the page logged, as data`);
  writeFileSync(join(dir, 'README.md'), readme(e, files, about.note, f));
  const width = Math.max(...files.map(([n]) => n.length), 'README.md'.length);
  const first = f ? 'what failed, the steps that led there, the errors and the failed requests' : 'what the page was, the errors it logged and its failed requests';
  return [
    `saved ${f ? 'what the page was when the step failed' : 'the page as it is'} to ${dir}`,
    ...[['README.md', first] as [string, string], ...files].map(([n, what]) => `  ${n.padEnd(width)}  ${what}`),
  ].join('\n');
}
