// What developers lean on: an accessibility check (test/a11y.html has one of
// each problem, beside the same things done right), expect, recording what's
// done as a script and replaying it, the script as a Playwright test, a
// reload that says what changed, and watch.
//
//   bun test/dev.ts

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION = 'dev-test';
const OTHER = 'dev-test-replay';
const cli = join(import.meta.dir, '..', 'src', 'medley.ts');
const page = (path: string) => pathToFileURL(path).href;
// Without a PASSWORD of its own, so a script that reads one gets only the test's.
const { PASSWORD: _, ...ENV } = process.env;
const run = (session: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [cli, '--session', session, '--no-color', ...args], { encoding: 'utf8', env: { ...ENV, ...env } });
  return { out: (r.stdout + r.stderr).trim(), status: r.status };
};
const medley = (...args: string[]) => run(SESSION, args).out;

let failures = 0;
const check = (what: string, ok: boolean, got = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures++;
    if (got) console.log(got.split('\n').map((l) => `     | ${l}`).join('\n'));
  }
};

const dir = join(tmpdir(), 'medley-dev-test');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
medley('stop');
run(OTHER, ['stop']);
try {
  // The accessibility check finds each problem once, and not the same things done right.
  medley('goto', page(join(import.meta.dir, 'a11y.html')));
  let out = medley('audit');
  const found = (text: string) => out.includes(text);
  check('audit: a picture without alt, not the one with alt="" or one with alt text', found('1 picture has no text alternative') && found('img ridge-runner.jpg'), out);
  check('an icon button and an unlabelled field have no name; the labelled ones do', found('2 controls have no name') && found('[1 button] · button.icon') && found('textbox "coupon"'), out);
  check('low contrast, but not #767676, nor white text over a picture', found('#aaaaaa on #ffffff is 2.3:1') && found('on #1d2a33') && !found('767676') && !found('White text'), out);
  check('a div with a click handler: not by keyboard; with tabindex, no role', found("1 control can't be reached with the keyboard") && found('1 clickable element is not a button'), out);
  check('a focusable link hidden from screen readers', found('hidden from screen readers (aria-hidden) but can be tabbed into'), out);
  check('a frame without a title, not the one with', found('1 frame has no title'), out);
  check('no language, and zoom turned off', found("doesn't say what language") && found('stops people zooming in'), out);
  check('warnings: placeholder only, "Read more", a skipped heading, tabindex 3, a file name for alt',
    found('labelled only by a placeholder') && found('"Read more" 2×') && found('h1 "Trail Co-op" → h3 "Shoes"') && found('tabindex="3"') && found('alt="IMG_2041.jpg"'), out);
  const json = JSON.parse(medley('audit', '--json') || '{}');
  check('audit --json: findings as data, with refs and their labels', json.findings?.some((f: { rule: string; label?: string }) => f.rule === 'name' && f.label === '[1 button]'), JSON.stringify(json).slice(0, 400));

  // expect: fine when the text is there; an error (exit status 1) when it isn't.
  let r = run(SESSION, ['expect', 'Members save']);
  check('expect: ok, and where', r.status === 0 && r.out.startsWith('ok: "Members save" is on the page · main › # Trail Co-op'), r.out);
  r = run(SESSION, ['expect', '--gone', 'Members save']);
  check('expect --gone: fails, exit status 1', r.status === 1 && r.out.includes('expected "Members save" to be gone'), r.out);

  // Recording: what's done, as steps that name what they act on, then replayed in another session.
  const demo = page(join(import.meta.dir, '..', 'docs', 'demo', 'index.html'));
  const script = join(dir, 'notes.medley');
  medley('goto', demo);
  out = medley('record', 'start', script);
  check('record start: from the page it is on', out.startsWith(`recording to ${script}, from ${demo}`), out);
  medley('click', 'Menu');
  medley('type', 'Email', 'ada@example.com');
  medley('fill', 'Monthly, not weekly=off');
  medley('click', 'button', 'Subscribe');
  medley('dialog', 'accept');
  medley('expect', 'Thanks');
  medley('snapshot'); // looking isn't a step
  out = medley('record', 'stop');
  const steps = [
    `goto ${demo}`,
    'click button Menu',
    'type "textbox Email" ada@example.com',
    'fill "checkbox Monthly, not weekly=off"',
    'click button Subscribe',
    'dialog accept',
    'expect Thanks',
  ];
  check('record stop: the steps, by name', out.startsWith('stopped recording: 7 steps') && out.endsWith(steps.join('\n')), out);
  r = run(OTHER, ['replay', script]);
  check('replay in a fresh session: every step', r.status === 0 && (r.out.match(/^✓ /gm) ?? []).length === 7 && r.out.includes('replayed'), r.out);
  const broken = join(dir, 'broken.medley');
  writeFileSync(broken, readFileSync(script, 'utf8').replace('expect Thanks', 'expect Welcome back'));
  r = run(OTHER, ['replay', broken]);
  check('a check that fails stops it, exit status 1', r.status === 1 && r.out.includes('✗ 7 expect Welcome back') && r.out.includes('stopped at step 7 of 7'), r.out);
  out = run(SESSION, ['playwright', script]).out;
  check('as a Playwright test', out.includes(`await page.getByRole('button', { name: "Subscribe" }).click();`) &&
    out.includes("page.once('dialog', (dialog) => dialog.accept());") && out.includes('.uncheck();') &&
    out.includes('await expect(page.getByText("Thanks").first()).toBeVisible();'), out);

  // What's typed into a password isn't kept: the script reads it from the environment.
  const secret = join(dir, 'secret.medley');
  medley('goto', page(join(import.meta.dir, 'app.html')));
  medley('record', 'start', secret);
  medley('type', 'password Password', 'hunter2');
  medley('record', 'stop');
  const text = readFileSync(secret, 'utf8');
  check('a password is recorded as ${PASSWORD}', text.includes('type "password Password" ${PASSWORD}') && !text.includes('hunter2'), text);
  const unset = run(OTHER, ['replay', secret]);
  check('replaying it without PASSWORD set says so', unset.status === 1 && unset.out.includes('reads PASSWORD from the environment'), unset.out);
  r = run(OTHER, ['replay', secret], { PASSWORD: 'swordfish' });
  const typed = run(OTHER, ['find', 'Password has']).out;
  check('with it set, it types it', r.status === 0 && typed.includes('Password has 9 characters'), `${r.out}\n${typed}`);

  // A reload that says what changed, for a page being edited: renumbered refs aren't changes.
  const site = join(dir, 'site');
  mkdirSync(site);
  const index = join(site, 'index.html');
  const html = (price: string, extra = '') => `<!doctype html><title>Prices</title><main><h1>Prices</h1>${extra}<p>Tent: ${price}</p><p><a href="a">A</a> <a href="b">B</a></p></main>`;
  writeFileSync(index, html('$289'));
  medley('goto', page(index));
  writeFileSync(index, html('$299', '<p><a href="new">New</a></p>'));
  out = medley('reload', '--diff');
  check('reload --diff: only what changed', out.startsWith('reloaded · +2 -1 lines') && out.includes('- Tent: $289') && out.includes('+ Tent: $299') && !out.includes('- [1]A'), out);

  // watch: a change to a file reloads the page and says how its text changed.
  const watcher = spawn(process.execPath, [cli, '--session', SESSION, '--no-color', 'watch', site], { stdio: ['ignore', 'pipe', 'pipe'] });
  let seen = '';
  watcher.stdout.on('data', (d) => (seen += d));
  watcher.stderr.on('data', (d) => (seen += d));
  const until = async (test: () => boolean, ms = 15000) => {
    for (const end = Date.now() + ms; Date.now() < end && !test(); ) await Bun.sleep(100);
  };
  await until(() => seen.includes('watching'));
  writeFileSync(index, html('$309', '<p><a href="new">New</a></p><script>console.error("broke the page")</script>'));
  await until(() => seen.includes('+ Tent: $309'));
  watcher.kill();
  check('watch: a saved file reloads the page, with the diff and the error it logged',
    /index\.html changed · reloaded · \+1 -1 lines/.test(seen) && seen.includes('+ Tent: $309') && seen.includes('note: the page logged 1 error: broke the page'), seen);
} finally {
  medley('stop');
  run(OTHER, ['stop']);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
