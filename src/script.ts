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
import { checksOf, countOf, meansOn, type Check } from './checks.ts';
import { CommandError, request, type Command, type StartOptions } from './client.ts';
import { parseCommand, splitFlags, tokenize, type Word } from './commands.ts';
import { matchRef, nameFor, parseLabel } from './names.ts';

// ---- recording ------------------------------------------------------------------

/** A command as a script line, with the secrets it left out (as ${NAME}) and anything to say about it. */
export interface Step {
  line: string;
  vars: string[];
  note?: string;
}

const CONTROL = /[\x00-\x1f\x7f]/;
const SHORT_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * A word as a script line needs it, to read back exactly (see tokenize): as
 * it is; in "double quotes" when it has spaces or single quotes or looks like
 * an option; in 'single quotes' when it has ${…} that isn't a secret to fill
 * in (`literal`), or double quotes; and as $'…' with escapes when it has
 * line breaks or other control characters, or both kinds of quote.
 */
function quote(word: string, literal = true): string {
  const dollar = literal && word.includes('${');
  if (CONTROL.test(word) || (word.includes('"') && word.includes("'")) || (dollar && word.includes("'"))) {
    const escaped = word.replace(/[\\']/g, '\\$&').replace(/[\x00-\x1f\x7f]/g, (c) => SHORT_ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
    return `$'${escaped}'`;
  }
  if (word && !/[\s"']/.test(word) && !word.startsWith('--') && !dollar) return word;
  return word.includes('"') || dollar ? `'${word}'` : `"${word}"`;
}

/**
 * Words that a command takes as its last argument, joined (click Add to
 * cart): as they are, if they read back the same; otherwise as one quoted word.
 */
function tail(text: string, literal = true): string {
  const words = tokenize(text);
  const plain = words.every((w) => !w.quoted && !w.text.startsWith('--') && !(literal && w.text.includes('${')));
  return plain && text !== '' && words.map((w) => w.text).join(' ') === text ? text : quote(text, literal);
}

// Fields whose values a script shouldn't keep: they're read from the environment when replayed.
const SECRET = /pass(word|code|phrase)?|\bpin\b|card|cvc|cvv|security code|\bssn\b|social security|one[- ]time|\botp\b|token|secret|api key/i;

function secretName(kind: string, name: string): string | null {
  if (kind === 'password') return 'PASSWORD';
  if (!SECRET.test(name)) return null;
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'SECRET';
}

/**
 * A command as a script line, its refs written as names (from `labels`, the
 * page as the one who acted saw it); null for commands that only look
 * (snapshot, find, audit…). A ref whose name doesn't single it out is kept
 * as its number, with a note. Whatever was typed reads back exactly, line
 * breaks, quotes and all; what went into a secret field is left out.
 */
export function stepFor({ cmd, args = {} }: Command, labels: Map<number, string>): Step | null {
  const vars: string[] = [];
  const notes: string[] = [];
  const q = (w: string) => quote(w);
  const t = (w: string) => tail(w);
  const el = (ref: unknown): string => {
    const n = Number(ref);
    const name = nameFor(labels, n);
    if (name) return name;
    notes.push(`${labels.get(n) ?? `[${n}]`} has no name of its own on the page, so it's by number, which may differ when replayed`);
    return String(n);
  };
  // What was typed into a field, or ${NAME} for a secret one, read from the environment when replayed.
  const secretOf = (ref: unknown, text: string): string | null => {
    const { kind, name } = parseLabel(labels.get(Number(ref)) ?? '');
    const secret = text ? secretName(kind, name) : null;
    if (secret) vars.push(secret);
    return secret;
  };
  const value = (ref: unknown, text: string): string => {
    const secret = secretOf(ref, text);
    return secret ? `\${${secret}}` : tail(text);
  };
  let words: string[];
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
      words = ['type', q(el(args.ref)), args.text ? value(args.ref, String(args.text)) : '""', ...(args.submit ? ['--submit'] : [])];
      break;
    case 'select':
      words = ['select', q(el(args.ref)), t(String(args.option ?? ''))];
      break;
    case 'fill': {
      const fields = Array.isArray(args.fields) ? (args.fields as { ref: unknown; value: unknown }[]) : [];
      words = ['fill', ...fields.map((f) => {
        const target = el(f.ref);
        const name = target.includes('=') ? String(Number(f.ref)) : target; // a name with = in it would split wrongly
        const text = String(f.value ?? '');
        const secret = secretOf(f.ref, text);
        return secret ? quote(`${name}=\${${secret}}`, false) : quote(`${name}=${text}`);
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
    case 'expect': {
      // Its options, then the text it looks for (or counts), which needs no quotes as the last words.
      words = ['expect'];
      let last = '';
      // An element as the step names it: its kind and name, whether it came as a number or a name.
      const named = (ref: string): { n: number | null; name: string } => {
        if (/^\d+$/.test(ref)) return { n: Number(ref), name: el(ref) };
        let n: number | null = null;
        try {
          n = matchRef(labels, ref, false);
        } catch {}
        return { n, name: (n !== null && nameFor(labels, n)) || ref };
      };
      for (const c of checksOf(args)) {
        if (c.kind === 'text' && c.gone) words.push('--gone', q(c.text));
        else if (c.kind === 'text') last = t(c.text);
        else if (c.kind === 'count') {
          words.push('--count', String(c.n));
          last = t(c.text);
        } else if (c.kind === 'url' || c.kind === 'title') words.push(`--${c.kind}`, q(c.text));
        else if (c.kind === 'state') words.push(`--${c.state}`, q(named(c.ref).name));
        else if (c.kind === 'errors') words.push('--no-errors');
        else {
          const { n, name } = named(c.ref);
          const field = name.includes('=') && n !== null ? String(n) : name; // a name with = in it would split wrongly
          const secret = n === null ? null : secretOf(n, c.text);
          words.push('--value', secret ? quote(`${field}=\${${secret}}`, false) : quote(`${field}=${c.text}`));
        }
      }
      if (args.seconds !== undefined && Number(args.seconds) !== 5) words.push('--within', String(Number(args.seconds)));
      if (last) words.push(last);
      break;
    }
    case 'dialog':
      words = ['dialog', String(args.action), ...(args.text !== undefined ? [q(String(args.text))] : [])];
      break;
    default:
      return null;
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
// A literal "${" (in 'single quotes') while a step is turned into code, kept apart from a ${NAME} (see js).
const LITERAL_DOLLAR = '$\u0001{';

/** The environment variables a script reads, as ${NAME} (not in 'single quotes', which are taken literally). */
export function scriptVars(steps: ScriptStep[]): string[] {
  const names = steps.flatMap((s) => tokenize(s.text).filter((w) => w.quoted !== "'").flatMap((w) => [...w.text.matchAll(VAR)].map((m) => m[1])));
  return [...new Set(names)];
}

// Not steps: they'd end or change the session the script runs in.
const NOT_STEPS = new Set(['stop', 'record', 'replay', 'playwright', 'watch', 'tui', 'mcp']);

export interface StepResult {
  step: ScriptStep;
  ok: boolean;
  text: string; // the result, or why it failed
  ms: number;
}

/**
 * A step's command, with its ${NAME}s filled in from `vars`, except in
 * 'single quotes'. With `vars` null they're kept, for toPlaywright.
 */
export function stepCommand(step: ScriptStep, vars: Record<string, string | undefined> | null) {
  const words = tokenize(step.text).map((w): Word => {
    if (w.quoted === "'") return vars ? w : { ...w, text: w.text.replaceAll('${', LITERAL_DOLLAR) };
    if (!vars || !w.text.includes('${')) return w;
    // Filled in, it's text, never an option, whatever it says.
    return { text: w.text.replace(VAR, (_, name: string) => vars[name] ?? ''), quoted: '"' };
  });
  const { words: rest, flags } = splitFlags(words);
  if (NOT_STEPS.has(rest[0])) throw new Error(`${rest[0]} can't be a step of a script`);
  return parseCommand(rest, flags);
}

/**
 * Run a script's steps in the named session, one after another, stopping at
 * the first that fails. A name not on the page yet is looked for again for a
 * few seconds, since pages often draw a moment after they load. With
 * `keepGoing`, an expect that fails doesn't stop the rest: a check says
 * something of the page and changes nothing, so those after it still mean
 * what they did (a failed action still stops them: they'd be acting on a page
 * that isn't where the script thinks). `stop` is asked before each step, and
 * ends the run when it says so. What the person watching says meanwhile (to
 * an agent: see talk.ts) comes with the steps' answers, and goes to `heard`.
 */
export async function replay(
  session: string,
  steps: ScriptStep[],
  opts: {
    client: string;
    start?: StartOptions;
    vars: Record<string, string | undefined>;
    onStep?: (r: StepResult, i: number) => void;
    keepGoing?: boolean;
    stop?: () => boolean;
    heard?: (messages: string[]) => void;
    within?: number; // how long an expect that doesn't say waits, in seconds (the session's own: 5)
  },
): Promise<StepResult[]> {
  const missing = scriptVars(steps).filter((v) => opts.vars[v] === undefined);
  if (missing.length) throw new Error(`the script reads ${missing.join(', ')} from the environment; set ${missing.length === 1 ? 'it' : 'them'} and run it again`);
  const results: StepResult[] = [];
  for (const [i, step] of steps.entries()) {
    if (opts.stop?.()) break;
    const t0 = performance.now();
    let result: StepResult;
    let check = false;
    try {
      const { cmd, args, start } = stepCommand(step, opts.vars);
      check = cmd === 'expect';
      if (check && opts.within && args.seconds === undefined) args.seconds = opts.within;
      const run = async () => {
        try {
          const reply = await request(session, { cmd, args, client: opts.client }, start ? (opts.start ?? {}) : undefined);
          if (reply.messages?.length) opts.heard?.(reply.messages);
          return reply;
        } catch (e) {
          if (e instanceof CommandError && e.messages.length) opts.heard?.(e.messages);
          throw e;
        }
      };
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
    if (!result.ok && !(opts.keepGoing && check)) break;
  }
  return results;
}

// After a change to a page that has settled, a check that isn't so rarely becomes so: checks wait this long, not 5 seconds.
export const CHECK_WAIT_S = 2;

/** What a run of checks came to: what to say of it, how many failed, and how each step went (for the run after it). */
export interface ChecksReport {
  lines: string[];
  failed: number;
  outcome: Map<string, boolean>;
}

const stepKey = (s: ScriptStep) => `${s.line} ${s.text}`;

/**
 * How a script went, run as checks (replay with keepGoing), for saying again
 * after every change to a page: what failed and why, what this change broke
 * and what it fixed (against `before`, the run before it), and what wasn't
 * run. What passed and passed before isn't listed. `since` names the change:
 * "this save".
 */
export function checksReport(
  results: StepResult[],
  steps: ScriptStep[],
  name: string,
  { before, since = 'this change', interrupted = false }: { before?: Map<string, boolean>; since?: string; interrupted?: boolean } = {},
): ChecksReport {
  const outcome = new Map(results.map((r) => [stepKey(r.step), r.ok]));
  const failed = results.filter((r) => !r.ok);
  const notRun = steps.length - results.length;
  const secs = `${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s`;
  const head = failed.length
    ? `${failed.length} of ${results.length} failed`
    : notRun
      ? `${results.length} passed, ${notRun} not run`
      : `all ${results.length} passed`;
  const lines = [`checks: ${head} (${name}, ${secs})`];
  results.forEach((r, i) => {
    const was = before?.get(stepKey(r.step));
    if (r.ok) {
      if (was === false) lines.push(`✓ ${i + 1} ${r.step.text} · fixed by ${since}`);
      return;
    }
    const tag = was === true ? ` · broken by ${since}` : was === false ? ' · still failing' : '';
    // Which page it was, and how long it waited, go without saying here.
    const why = r.text.replace(/ \(after \d+s(; the page is ".*", \S+)?\)$/m, '');
    lines.push(`✗ ${i + 1} ${r.step.text}${tag}`, ...why.split('\n').map((l) => `    ${l}`));
  });
  if (notRun) {
    const last = results.at(-1);
    const why = interrupted ? 'a newer change came first' : last && !last.ok ? `step ${results.length} has to work first` : 'the run was cut short';
    lines.push(`· ${notRun === 1 ? '1 step' : `${notRun} steps`} not run: ${why}`);
  }
  return { lines, failed: failed.length, outcome };
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

/**
 * Save what the page was when a replay's step failed (a bundle: see
 * bundle.ts), with the step, what went wrong and the steps before it, to
 * `dir` or a folder of medley's own. Returns what to say of it: where it
 * went, or why it couldn't be saved; '' when nothing failed.
 */
export async function bundleFailure(
  session: string,
  client: string,
  steps: ScriptStep[],
  results: StepResult[],
  script: { name: string; text: string },
  dir?: string,
): Promise<string> {
  const last = results.at(-1);
  if (!last || last.ok) return '';
  const failure = {
    script: script.name,
    scriptText: script.text,
    step: results.length,
    total: steps.length,
    line: last.step.line,
    command: last.step.text,
    error: last.text,
    log: results.flatMap((r, i) => stepLines(r, i + 1)),
    rest: steps.slice(results.length).map((s) => s.text),
    vars: scriptVars(steps),
  };
  try {
    const { text } = await request(session, { cmd: 'bundle', args: { dir, failure }, client });
    return `${text.split('\n')[0]}: its README.md says what failed, beside the page's text, a picture of it, and what it logged`;
  } catch (e) {
    return `what the page was couldn't be saved: ${(e as Error).message.split('\n')[0]}`;
  }
}

/** How a replay went, in a line. */
export function replaySummary(results: StepResult[], total: number, name: string): string {
  const last = results.at(-1);
  const secs = `${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(1)}s`;
  const failed = results.filter((r) => !r.ok).length;
  // Kept going past failed checks (see replay): it reached the end, but not all of it held.
  if (failed && last?.ok) return `replayed ${name}: ${failed} of ${results.length === 1 ? '1 step' : `${results.length} steps`} failed, in ${secs}`;
  if (!last || last.ok) return `replayed ${name}: ${total === 1 ? '1 step' : `${total} steps`} in ${secs}`;
  return `replay of ${name} stopped at step ${results.length} of ${total} (line ${last.step.line})${failed > 1 ? `; ${failed} steps failed` : ''}`;
}

// ---- as a Playwright test -----------------------------------------------------------

const ROLES: Record<string, string> = {
  link: 'link', button: 'button', textbox: 'textbox', combobox: 'combobox', select: 'combobox', checkbox: 'checkbox',
  radio: 'radio', slider: 'slider', tab: 'tab', menuitem: 'menuitem', option: 'option',
};

/** A string as JavaScript, with ${NAME}s read from the environment. */
function js(text: string): string {
  const parts = text.split(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
  const code = parts
    .map((p, i) => (i % 2 ? `(process.env.${p} ?? '')` : JSON.stringify(p.replaceAll(LITERAL_DOLLAR, '${'))))
    .filter((p, i) => i % 2 || p !== '""');
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

// Playwright's matcher for each state a check can ask about, with its arguments.
const STATE_MATCHERS: Record<string, [string, ...string[]]> = {
  checked: ['toBeChecked'],
  unchecked: ['not.toBeChecked'],
  enabled: ['toBeEnabled'],
  disabled: ['toBeDisabled'],
  focused: ['toBeFocused'],
  expanded: ['toHaveAttribute', "'aria-expanded'", "'true'"],
  collapsed: ['toHaveAttribute', "'aria-expanded'", "'false'"],
  selected: ['toHaveAttribute', "'aria-selected'", "'true'"],
  pressed: ['toHaveAttribute', "'aria-pressed'", "'true'"],
};

/**
 * A check as a Playwright assertion (without its await), or a // comment for
 * one that doesn't translate. `timeout` is "{ timeout: 8000 }", or '' for
 * Playwright's own.
 */
function assertion(c: Check, timeout: string): string {
  // A matcher called with its arguments, the timeout last when there is one.
  const m = (matcher: string, ...args: string[]) => `${matcher}(${[...args, timeout].filter(Boolean).join(', ')})`;
  switch (c.kind) {
    case 'text':
      return `expect(page.getByText(${js(c.text)}).first()).${m(c.gone ? 'toBeHidden' : 'toBeVisible')}`;
    case 'count': {
      const of = countOf(c.text);
      if (!of) return `expect(page.getByText(${js(c.text)})).${m('toHaveCount', String(c.n))}`;
      if (!ROLES[of.kind]) return `// expect --count ${c.n} ${c.text}: count them with a locator of your own (Playwright has no role for "${of.kind}")`;
      return `expect(page.getByRole('${ROLES[of.kind]}'${of.name ? `, { name: ${js(of.name)} }` : ''})).${m('toHaveCount', String(c.n))}`;
    }
    case 'url':
      return `expect.${m('poll', '() => page.url()')}.toContain(${js(c.text)})`;
    case 'title':
      return `expect.${m('poll', 'async () => (await page.title()).toLowerCase()')}.toContain(${js(c.text)}.toLowerCase())`;
    case 'value': {
      const kind = /^(\w+) /.exec(c.ref)?.[1];
      if (kind === 'checkbox' || kind === 'radio') return `expect(${locator(c.ref)}).${m(meansOn(c.text) ? 'toBeChecked' : 'not.toBeChecked')}`;
      if (kind === 'select') return `expect(${locator(c.ref)}.locator('option:checked')).${m('toHaveText', js(c.text))}`;
      return `expect(${locator(c.ref)}).${m('toHaveValue', js(c.text))}`;
    }
    case 'state':
      return `expect(${locator(c.ref)}).${m(...STATE_MATCHERS[c.state])}`;
    case 'errors':
      return "expect(errors, 'errors the page logged').toEqual([])";
  }
}

/**
 * The script as a Playwright test (@playwright/test), step for step, for a
 * test suite or CI. What doesn't translate (tabs, a ref kept as its number)
 * comes out as a comment or a TODO.
 */
export function toPlaywright(steps: ScriptStep[], file: string): string {
  const name = basename(file, extname(file)) || 'medley script';
  const body: string[] = [];
  let hearsErrors = false; // a step checks that the page logged no errors: the test listens for them from the start
  const todo = (step: ScriptStep, why: string) => body.push(`  // line ${step.line}: ${step.text} (${why})`);
  steps.forEach((step, i) => {
    let cmd: string;
    let args: Record<string, any>;
    try {
      ({ cmd, args } = stepCommand(step, null));
    } catch (e) {
      return todo(step, (e as Error).message);
    }
    // Playwright dismisses a page's dialogs unless told beforehand what to do.
    const next = steps[i + 1];
    if (next && /^dialog accept\b/.test(next.text)) {
      const text = stepCommand(next, null).args.text;
      body.push(`  page.once('dialog', (dialog) => dialog.accept(${text !== undefined ? js(String(text)) : ''}));`);
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
      case 'expect': {
        const timeout = args.seconds ? `{ timeout: ${Number(args.seconds) * 1000} }` : '';
        for (const c of args.checks as Check[]) {
          const line = assertion(c, timeout);
          if (line.startsWith('//')) body.push(`  ${line}`);
          else if (c.kind === 'errors') body.push(`  ${line};`); // nothing to wait for: they're counted as they're logged
          else w(line);
          if (c.kind === 'errors') hearsErrors = true;
        }
        return;
      }
      case 'dialog':
        if (args.action === 'dismiss') body.push("  // the dialog is dismissed: Playwright's default");
        return; // accepting was set up before the step that opened it
      default:
        return todo(step, "tabs and history don't translate one to one");
    }
  });
  const hear = [
    '  // What the page logs as errors, and its uncaught errors, for the checks below that there were none.',
    '  const errors: string[] = [];',
    "  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && errors.push(m.text()));",
    "  page.on('pageerror', (e) => errors.push(String(e)));",
  ];
  return [
    `// Made by medley from ${basename(file)}.`,
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${JSON.stringify(name)}, async ({ page }) => {`,
    ...(hearsErrors ? hear : []),
    ...body,
    '});',
    '',
  ].join('\n');
}

