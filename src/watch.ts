// medley watch: reload the session's page whenever files change, and print how
// its text changed, with any errors it logged. A quick loop for someone (or an
// agent) editing a site: save, and see what the page says now. With checks (a
// script of steps and expects), they're run after every save too, and it says
// what failed, what the save broke and what it fixed: save, and see whether
// it still works.

import { readFileSync, watch as watchDir } from 'node:fs';
import { basename } from 'node:path';
import { request } from './client.ts';
import { CHECK_WAIT_S, checksReport, parseScript, replay, scriptVars, type ScriptStep } from './script.ts';

// Changes that aren't to the site: dependencies, version control, editors' scratch files.
const IGNORED = /(^|[\\/])(node_modules|\.git|\.hg|\.svn|\.cache|\.next|\.nuxt|\.turbo|\.parcel-cache|coverage)([\\/]|$)|(~|\.swp|\.swx|\.tmp|\.DS_Store|4913)$/;
const QUIET_MS = 250; // a save often writes several files; wait for them all

export interface WatchOptions {
  session: string;
  dir: string;
  hot: boolean; // the dev server updates the page itself: wait for it instead of reloading
  client: string;
  print: (text: string) => void;
  checks?: string[]; // scripts to run as checks after every save (their files)
  vars?: Record<string, string | undefined>; // what ${NAME}s in them stand for
}

/** A checks script as it is now: read again before each run, so editing it takes effect on the next save. */
function readChecks(file: string, vars: Record<string, string | undefined>): ScriptStep[] {
  const steps = parseScript(readFileSync(file, 'utf8'));
  if (!steps.length) throw new Error(`${file} has no steps`);
  const missing = scriptVars(steps).filter((v) => vars[v] === undefined);
  if (missing.length) throw new Error(`${file} reads ${missing.join(', ')} from the environment; set ${missing.length === 1 ? 'it' : 'them'} first`);
  return steps;
}

export async function watchFiles(o: WatchOptions): Promise<void> {
  const clock = () => new Date().toTimeString().slice(0, 8);
  const vars = o.vars ?? process.env;
  const checks = o.checks ?? [];
  for (const file of checks) readChecks(file, vars); // a script that can't run says so now, not after the first save
  // The page as it is now is what the first change is compared with.
  const first = await request(o.session, { cmd: 'snapshot', args: { outline: true }, client: o.client });
  const [title = '', meta = ''] = first.text.split('\n').filter((l) => !l.startsWith('note: '));
  const watched = meta.split(' · ')[0];
  const page = `"${title}" (${watched})`;

  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  // How each script's steps went the last time, to tell what a save broke and what it fixed.
  const before = new Map<string, Map<string, boolean>>();
  /**
   * Run the checks, as a client of their own (what they do to the page isn't
   * taken for a change to it at the next save). A newer save ends the run:
   * the page they'd be checking is already out of date.
   */
  const check = async () => {
    for (const file of checks) {
      const name = basename(file);
      try {
        const steps = readChecks(file, vars);
        const results = await replay(o.session, steps, { client: `${o.client}-checks`, vars, keepGoing: true, within: CHECK_WAIT_S, stop: () => changed.size > 0 });
        const report = checksReport(results, steps, name, { before: before.get(file), since: 'this save', interrupted: changed.size > 0 });
        before.set(file, report.outcome);
        o.print(report.lines.join('\n'));
      } catch (e) {
        o.print(`checks: ${name} couldn't be run: ${(e as Error).message}`);
      }
      if (changed.size) return;
    }
  };

  /**
   * Checks may leave the page (a click that goes on to the cart): before
   * looking at what a save did, go back to the page being watched. As the
   * checks' client, so the change is still told against the page as it was.
   */
  const goBack = async () => {
    const tabs = JSON.parse((await request(o.session, { cmd: 'tabs', args: { json: true }, client: o.client })).text) as { url: string; current: boolean }[];
    const now = tabs.find((t) => t.current)?.url ?? watched;
    if (now.split('#')[0] !== watched.split('#')[0]) await request(o.session, { cmd: 'goto', args: { url: watched }, client: `${o.client}-checks` });
  };

  const run = async () => {
    if (running) return; // runs again when this one is done
    running = true;
    try {
      while (changed.size) {
        const files = [...changed];
        changed.clear();
        const which = files.length > 3 ? `${files.slice(0, 3).join(', ')} and ${files.length - 3} more` : files.join(', ');
        try {
          if (checks.length) await goBack();
          const command = o.hot ? { cmd: 'wait', args: { seconds: 1, diff: true } } : { cmd: 'reload', args: { diff: true } };
          const reply = await request(o.session, { ...command, client: o.client });
          o.print('');
          o.print(`${clock()} ${which} changed · ${reply.text}`);
        } catch (e) {
          o.print('');
          o.print(`${clock()} ${which} changed · ${(e as Error).message}`);
          continue; // nothing to check: the page didn't come
        }
        await check();
      }
    } finally {
      running = false;
    }
  };

  const watcher = watchDir(o.dir, { recursive: true }, (_event, file) => {
    const name = file ? String(file) : '';
    if (!name || IGNORED.test(name)) return;
    changed.add(name.replace(/\\/g, '/'));
    clearTimeout(timer);
    timer = setTimeout(run, QUIET_MS);
  });
  // Said once it's watching, so a save made on seeing this is never missed.
  const then = checks.length ? `, saying how its text changed, and running ${checks.map((f) => basename(f)).join(', ')}` : ' and saying how its text changed';
  o.print(`watching ${o.dir}: when files change, ${o.hot ? `waiting for ${page} to update itself` : `reloading ${page}`}${then} (Ctrl+C stops)`);
  // How the checks stand before anything is changed.
  if (checks.length) {
    running = true;
    await check().finally(() => {
      running = false;
    });
    if (changed.size) void run();
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      watcher.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
