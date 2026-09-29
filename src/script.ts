// Scripts: what's done in a session, written down as it's done (record) as the
// commands that do it, one per line, then done again without an agent or its
// tokens (replay): a chore such as signing in, or a check that a site still
// works. Steps name elements rather than numbering them ("click button Add to
// cart"), since numbers change from page to page and names mostly don't. A
// script is plain text, to read, edit and keep:
//
//   # a medley script, recorded 2026-09-29 14:03
//   goto https://example.com/shop
//   click link Trail shoes
//   fill "textbox Email=ada@example.com" "password Password=${PASSWORD}"
//   click button Sign in
//   expect Welcome back

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { sleep } from './browser.ts';
import { request, type Command, type StartOptions } from './client.ts';
import { parseCommand, splitFlags, splitWords } from './commands.ts';
import { nameFor, parseLabel } from './names.ts';

// ---- recording ------------------------------------------------------------------

/** A command as a script line, with the secrets it left out (as ${NAME}) and anything to say about it. */
export interface Step {
  line: string;
  vars: string[];
  note?: string;
}

/**
 * A word as a script line needs it: as it is, or in quotes when it has
 * spaces or quotes or looks like an option. Null when it has both kinds of quote.
 */
function quote(word: string): string | null {
  if (word && !/[\s"']/.test(word) && !word.startsWith('--')) return word;
  if (!word.includes('"')) return `"${word}"`;
  if (!word.includes("'")) return `'${word}'`;
  return null;
}

/** Words that a command takes as its last argument, joined (click Add to cart): as they are, if they read back the same. */
function tail(text: string): string | null {
  const back = splitFlags(splitWords(text)).words.join(' ');
  return back === text && text !== '' ? text : quote(text);
}

// Fields whose values a script shouldn't keep: they're read from the environment when replayed.
const SECRET = /pass(word|code|phrase)?|\bpin\b|card|cvc|cvv|security code|\bssn\b|social security|one[- ]time|\botp\b|token|secret|api key/i;

function secretName(kind: string, name: string): string | null {
  if (kind === 'password') return 'PASSWORD';
  if (!SECRET.test(name)) return null;
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'SECRET';
}

class Unwritable extends Error {}

/**
 * A command as a script line, its refs written as names (from `labels`, the
 * page as the one who acted saw it); null for commands that only look
 * (snapshot, find, audit…). A ref whose name doesn't single it out is kept
 * as its number, with a note.
 */
export function stepFor({ cmd, args = {} }: Command, labels: Map<number, string>): Step | null {
  const vars: string[] = [];
  const notes: string[] = [];
  const q = (w: string) => quote(w) ?? thrown(w);
  const t = (w: string) => tail(w) ?? thrown(w);
  const thrown = (w: string): never => {
    throw new Unwritable(`${cmd} with ${w.length > 40 ? w.slice(0, 39) + '…' : w}, which has both kinds of quote`);
  };
  const el = (ref: unknown): string => {
    const n = Number(ref);
    const name = nameFor(labels, n);
    if (name) return name;
    notes.push(`${labels.get(n) ?? `[${n}]`} has no name of its own on the page, so it's by number, which may differ when replayed`);
    return String(n);
  };
  const value = (ref: unknown, text: string): string => {
    const { kind, name } = parseLabel(labels.get(Number(ref)) ?? '');
    const secret = text ? secretName(kind, name) : null;
    if (!secret) return text;
    vars.push(secret);
    return `\${${secret}}`;
  };
  let words: string[];
  try {
    switch (cmd) {
      case 'goto': {
        const search = args.search ?? args.query;
        words = search ? ['search', t(String(search))] : ['goto', q(String(args.url))];
        break;
      }
      case 'click':
        words = ['click', t(el(args.ref)), ...(args.newTab ? ['--new-tab'] : [])];
        break;
      case 'hover':
        words = ['hover', t(el(args.ref))];
        break;
      case 'type':
        words = ['type', q(el(args.ref)), ...(args.text ? [t(value(args.ref, String(args.text)))] : ['""']), ...(args.submit ? ['--submit'] : [])];
        break;
      case 'select':
        words = ['select', q(el(args.ref)), t(String(args.option ?? ''))];
        break;
      case 'fill': {
        const fields = Array.isArray(args.fields) ? (args.fields as { ref: unknown; value: unknown }[]) : [];
        words = ['fill', ...fields.map((f) => {
          const target = el(f.ref);
          return q(`${target.includes('=') ? Number(f.ref) : target}=${value(f.ref, String(f.value ?? ''))}`);
        }), ...(args.submit ? ['--submit'] : [])];
        break;
      }
      case 'upload':
        words = ['upload', q(el(args.ref)), ...(Array.isArray(args.files) ? args.files.map((f) => q(String(f))) : [])];
        break;
      case 'drag': {
        // A ref it was dropped on is found again by its text, as a drop zone is.
        const to = /^\d+$/.test(String(args.to)) ? parseLabel(labels.get(Number(args.to)) ?? '').name || String(args.to) : String(args.to);
        words = ['drag', q(el(args.from)), q(to)];
        break;
      }
      case 'scroll': {
        const to = String(args.to ?? 'down');
        words = ['scroll', /^\d+$/.test(to) ? t(el(to)) : to];
        break;
      }
      case 'press':
        words = ['press', q(String(args.key))];
        break;
      case 'reload':
        words = ['reload', ...(args.hard ? ['--hard'] : [])];
        break;
      case 'back':
      case 'forward':
        words = [cmd];
        break;
      case 'history':
        if (args.n === undefined) return null; // only listed it
        words = ['history', String(args.n)];
        break;
      case 'newtab':
        words = ['newtab', ...(args.url ? [q(String(args.url))] : [])];
        break;
      case 'tab':
        words = ['tab', String(args.n)];
        break;
      case 'close-tab':
        words = ['close-tab', ...(args.n !== undefined ? [String(args.n)] : [])];
        break;
      case 'wait': {
        const seconds = args.seconds !== undefined && args.seconds !== '' ? [String(args.seconds)] : [];
        if (args.for !== undefined) words = ['wait', '--for', q(String(args.for)), ...seconds];
        else if (args.gone !== undefined) words = ['wait', '--gone', q(String(args.gone)), ...seconds];
        else words = ['wait', ...(seconds.length ? seconds : ['2'])];
        break;
      }
      case 'expect':
        words = args.gone ? ['expect', '--gone', q(String(args.text))] : ['expect', t(String(args.text))];
        break;
      case 'dialog':
        words = ['dialog', String(args.action), ...(args.text !== undefined ? [q(String(args.text))] : [])];
        break;
      default:
        return null;
    }
  } catch (e) {
    if (!(e instanceof Unwritable)) throw e;
    return { line: `# not written down: ${e.message}`, vars: [] };
  }
  return { line: words.join(' '), vars, ...(notes.length ? { note: notes.join('; ') } : {}) };
}

export interface RecordingStatus {
  steps: number;
  file: string;
}

/** Where a recording goes when no file was named: ~/.medley/recordings/<when>.medley */
export function defaultScriptFile(): string {
  const when = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return join(homedir(), '.medley', 'recordings', `${when}.medley`);
}

/** A script being recorded, saved to its file after every step, so nothing is lost if the session goes away. */
export class Recording {
  private lines: string[] = [];
  private vars = new Set<string>();
  private readonly started = new Date();

  constructor(readonly file: string) {}

  add(step: Step) {
    if (step.note) this.lines.push(`# ${step.note}`);
    this.lines.push(step.line);
    for (const v of step.vars) this.vars.add(v);
    this.save();
  }

  get count(): number {
    return this.lines.filter((l) => !l.startsWith('#')).length;
  }

  get status(): RecordingStatus {
    return { steps: this.count, file: this.file };
  }

  text(): string {
    const d = this.started;
    const two = (n: number) => String(n).padStart(2, '0');
    const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
    const head = [
      `# a medley script, recorded ${when}`,
      '# replay it with: medley replay <this file> · as a Playwright test: medley playwright <this file>',
    ];
    if (this.vars.size) {
      const names = [...this.vars].map((v) => `\${${v}}`).join(', ');
      head.push(`# what was typed into ${names.includes(',') ? 'secret fields' : 'a secret field'} isn't kept: replaying reads ${names} from the environment`);
    }
    return [...head, '', ...this.lines, ''].join('\n');
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.text());
  }
}

// ---- replaying ------------------------------------------------------------------

export interface ScriptStep {
  line: number; // in the file, from 1
  text: string;
}

/** A script's steps: its lines, without blank ones and # comments. */
export function parseScript(text: string): ScriptStep[] {
  return text.split(/\r?\n/).flatMap((raw, i) => {
    const text = raw.trim();
    return !text || text.startsWith('#') ? [] : [{ line: i + 1, text }];
  });
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The environment variables a script reads, as ${NAME}. */
export function scriptVars(steps: ScriptStep[]): string[] {
  return [...new Set(steps.flatMap((s) => [...s.text.matchAll(VAR)].map((m) => m[1])))];
}

// Not steps: they'd end or change the session the script runs in.
const NOT_STEPS = new Set(['stop', 'record', 'replay', 'playwright', 'watch', 'tui', 'mcp']);

export interface StepResult {
  step: ScriptStep;
  ok: boolean;
  text: string; // the result, or why it failed
  ms: number;
}

/** A step's command, with ${NAME}s filled in from `vars`. */
function stepCommand(step: ScriptStep, vars: Record<string, string | undefined>) {
  const words = splitWords(step.text).map((w) => w.replace(VAR, (_, name: string) => vars[name] ?? ''));
  const { words: rest, flags } = splitFlags(words);
  if (NOT_STEPS.has(rest[0])) throw new Error(`${rest[0]} can't be a step of a script`);
  return parseCommand(rest, flags);
}

/**
 * Run a script's steps in the named session, one after another, stopping at
 * the first that fails. A name not on the page yet is looked for again for a
 * few seconds, since pages often draw a moment after they load.
 */
export async function replay(
  session: string,
  steps: ScriptStep[],
  opts: { client: string; start?: StartOptions; vars: Record<string, string | undefined>; onStep?: (r: StepResult, i: number) => void },
): Promise<StepResult[]> {
  const missing = scriptVars(steps).filter((v) => opts.vars[v] === undefined);
  if (missing.length) throw new Error(`the script reads ${missing.join(', ')} from the environment; set ${missing.length === 1 ? 'it' : 'them'} and run it again`);
  const results: StepResult[] = [];
  for (const [i, step] of steps.entries()) {
    const t0 = performance.now();
    let result: StepResult;
    try {
      const { cmd, args, start } = stepCommand(step, opts.vars);
      const run = () => request(session, { cmd, args, client: opts.client }, start ? (opts.start ?? {}) : undefined);
      const until = Date.now() + 5000;
      let text = '';
      for (;;) {
        try {
          text = (await run()).text;
          break;
        } catch (e) {
          if (!/^nothing on the page is called/.test((e as Error).message) || Date.now() > until) throw e;
          await sleep(500);
        }
      }
      result = { step, ok: true, text, ms: performance.now() - t0 };
    } catch (e) {
      result = { step, ok: false, text: (e as Error).message, ms: performance.now() - t0 };
    }
    results.push(result);
    opts.onStep?.(result, i);
    if (!result.ok) break;
  }
  return results;
}

/** A step's result in a line or a few: what it did, and any notes (errors the page logged). */
export function stepLines(r: StepResult, n: number, { verbose = false } = {}): string[] {
  const secs = `${(r.ms / 1000).toFixed(1)}s`;
  if (!r.ok) return [`✗ ${n} ${r.step.text} (${secs})`, ...r.text.split('\n').map((l) => `    ${l}`)];
  const lines = r.text.split('\n');
  // A new page's first line is its title; an action's says what it did.
  let said = /^(goto|search|newtab) /.test(r.step.text) ? '' : lines[0];
  if (said.length > 100) said = said.slice(0, 99) + '…';
  const out = [`✓ ${n} ${r.step.text}${said ? ` · ${said}` : ''} (${secs})`];
  if (verbose) out.push(...lines.map((l) => `    ${l}`));
  else out.push(...lines.filter((l) => l.startsWith('note: ') || l.startsWith('the page is showing a ')).map((l) => `    ${l}`));
  return out;
}

/** How a replay went, in a line. */
export function replaySummary(results: StepResult[], total: number, name: string): string {
  const last = results.at(-1);
  const secs = `${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s`;
  if (!last || last.ok) return `replayed ${name}: ${total === 1 ? '1 step' : `${total} steps`} in ${secs}`;
  return `replay of ${name} stopped at step ${results.length} of ${total} (line ${last.step.line})`;
}

// ---- as a Playwright test -----------------------------------------------------------

const ROLES: Record<string, string> = {
  link: 'link', button: 'button', textbox: 'textbox', combobox: 'combobox', select: 'combobox', checkbox: 'checkbox',
  radio: 'radio', slider: 'slider', tab: 'tab', menuitem: 'menuitem', option: 'option',
};

/** A string as JavaScript, with ${NAME}s read from the environment. */
function js(text: string): string {
  const parts = text.split(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
  const code = parts.map((p, i) => (i % 2 ? `(process.env.${p} ?? '')` : JSON.stringify(p))).filter((p, i) => i % 2 || p !== '""');
  return code.length ? code.join(' + ') : '""';
}

/** Playwright's way to find what a step names: by role and name, by label, or by text. */
function locator(target: string): string {
  if (/^\d+$/.test(target)) return `page.locator('TODO: element ${target}, kept by its number')`;
  const m = /^(\w+) (.+)$/.exec(target);
  const kind = m?.[1] ?? '';
  const name = m ? m[2] : target;
  if (ROLES[kind]) return `page.getByRole('${ROLES[kind]}', { name: ${js(name)} })`;
  if (kind === 'password' || kind === 'file') return `page.getByLabel(${js(name)})`;
  return `page.getByText(${js(kind === 'clickable' || kind === 'draggable' ? name : target)}).first()`;
}

/**
 * The script as a Playwright test (@playwright/test), step for step, for a
 * test suite or CI. What doesn't translate (tabs, a ref kept as its number)
 * comes out as a comment or a TODO.
 */
export function toPlaywright(steps: ScriptStep[], file: string): string {
  const name = basename(file, extname(file)) || 'medley script';
  const body: string[] = [];
  const todo = (step: ScriptStep, why: string) => body.push(`  // line ${step.line}: ${step.text} (${why})`);
  steps.forEach((step, i) => {
    let cmd: string;
    let args: Record<string, any>;
    try {
      ({ cmd, args } = stepCommand(step, {}));
    } catch (e) {
      return todo(step, (e as Error).message);
    }
    // Playwright dismisses a page's dialogs unless told beforehand what to do.
    const next = steps[i + 1];
    if (next && /^dialog accept\b/.test(next.text)) {
      const text = splitWords(next.text).slice(2).join(' ');
      body.push(`  page.once('dialog', (dialog) => dialog.accept(${text ? js(text) : ''}));`);
    }
    const el = (ref: unknown) => locator(String(ref));
    const w = (code: string) => body.push(`  await ${code};`);
    switch (cmd) {
      case 'goto':
        return w(`page.goto(${js(String(args.url))})`);
      case 'click':
        if (args.newTab) return todo(step, "opened in a new tab: get it with page.context().waitForEvent('page')");
        return w(`${el(args.ref)}.click()`);
      case 'hover':
        return w(`${el(args.ref)}.hover()`);
      case 'type':
        w(`${el(args.ref)}.fill(${js(String(args.text ?? ''))})`);
        if (args.submit) w(`${el(args.ref)}.press('Enter')`);
        return;
      case 'select':
        return w(`${el(args.ref)}.selectOption(${js(String(args.option))})`);
      case 'fill':
        for (const f of args.fields as { ref: string; value: string }[]) {
          const kind = /^(\w+) /.exec(f.ref)?.[1];
          if (kind === 'checkbox' || kind === 'radio') w(`${el(f.ref)}.${/^(off|no|false|0|unchecked)?$/i.test(f.value.trim()) ? 'uncheck' : 'check'}()`);
          else if (kind === 'select') w(`${el(f.ref)}.selectOption(${js(f.value)})`);
          else if (kind === 'slider') w(`${el(f.ref)}.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, ${js(f.value)})`);
          else w(`${el(f.ref)}.fill(${js(f.value)})`);
        }
        if (args.submit) w(`page.keyboard.press('Enter')`);
        return;
      case 'upload':
        return w(`${el(args.ref)}.setInputFiles(${JSON.stringify(args.files)})`);
      case 'drag':
        return w(`${el(args.from)}.dragTo(page.getByText(${js(String(args.to))}).first())`);
      case 'press':
        return w(`page.keyboard.press(${js(String(args.key))})`);
      case 'scroll': {
        const to = String(args.to);
        if (to === 'down' || to === 'up') return w(`page.mouse.wheel(0, ${to === 'down' ? 600 : -600})`);
        if (to === 'top' || to === 'bottom') return w(`page.evaluate(() => window.scrollTo(0, ${to === 'top' ? 0 : 'document.body.scrollHeight'}))`);
        return w(`${el(to)}.scrollIntoViewIfNeeded()`);
      }
      case 'reload':
        return w('page.reload()');
      case 'back':
        return w('page.goBack()');
      case 'forward':
        return w('page.goForward()');
      case 'wait': {
        const ms = (Number(args.seconds) || (args.for !== undefined || args.gone !== undefined ? 10 : 2)) * 1000;
        if (args.for !== undefined) return w(`page.getByText(${js(String(args.for))}).first().waitFor({ timeout: ${ms} }).catch(() => {})`);
        if (args.gone !== undefined) return w(`page.getByText(${js(String(args.gone))}).first().waitFor({ state: 'hidden', timeout: ${ms} }).catch(() => {})`);
        return w(`page.waitForTimeout(${ms})`);
      }
      case 'expect':
        return w(`expect(page.getByText(${js(String(args.text))}).first()).${args.gone ? 'toBeHidden' : 'toBeVisible'}()`);
      case 'dialog':
        if (args.action === 'dismiss') body.push("  // the dialog is dismissed: Playwright's default");
        return; // accepting was set up before the step that opened it
      default:
        return todo(step, "tabs and history don't translate one to one");
    }
  });
  return [
    `// Made by medley from ${basename(file)}.`,
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${JSON.stringify(name)}, async ({ page }) => {`,
    ...body,
    '});',
    '',
  ].join('\n');
}

