// Failure bundles: a replay whose step fails leaves a folder with what
// failed, the steps that led there, and what the page was (its text, a
// picture, its HTML, its console and requests); the script in it fails the
// same way again; secrets stay out; a page that can't answer still gives
// what medley has of it. Also `bundle` by itself, over MCP, and the
// housekeeping of medley's own folder of bundles.
//
//   bun test/bundle.ts

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

process.env.MEDLEY_PAGE_TIMEOUT = '4'; // a stuck page is quick to give up on; read when medley's modules load
const { BUNDLES, pruneBundles, writeBundle } = await import('../src/bundle.ts');
const { Session } = await import('../src/session.ts');

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const page = PAGES[new URL(req.url).pathname];
    return page ? new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('not found', { status: 404 });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const PAGES: Record<string, string> = {
  '/shop': `<!doctype html><html lang="en"><title>Trail shop</title>
<h1>Trail shop</h1>
<p><button onclick="cart.innerHTML = 'Trail shoes <button>Remove</button>'">Add to cart</button></p>
<p id="cart">Your cart is empty</p>
<p><label>Password <input type="password" id="pw"></label></p>
<p><button onclick="console.error('checkout broke: no card'); fetch('/api/order')">Place order</button></p>
<p><button onclick="confirm('Leave the shop?')">Leave</button> <button onclick="setTimeout(() => { for (;;) {} }, 300)">Freeze</button></p>
<div style="height: 1500px"></div>
<p>The end of the page</p>`,
};

let failures = 0;
const check = (what: string, ok: boolean, got = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures++;
    if (got) console.log(got.split('\n').map((l) => `     | ${l}`).join('\n'));
  }
};
const dir = join(tmpdir(), 'medley-bundle-test');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
/** A PNG's width and height, from its header. */
const pngSize = (file: string) => {
  const png = readFileSync(file);
  return png.subarray(1, 4).toString() === 'PNG' ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null;
};
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

// What medley has of a page that can't answer, and of one behind a dialog.
const session = await Session.start();
try {
  const page = await session.goto('t', url('/shop'));
  const ref = (name: string) => Number(new RegExp(`\\[(\\d+) button "${name}"\\]`).exec(page)?.[1]);
  await session.click('t', ref('Place order'));
  await session.click('t', ref('Leave'));
  let e = await session.evidence();
  let out = join(dir, 'dialog');
  writeBundle(out, e, { note: 'A dialog was in the way.' });
  let readme = read(out, 'README.md');
  check('behind a dialog: the dialog is told, and what was logged before it is kept',
    e.dialog === 'confirm "Leave the shop?"' && e.html === undefined && readme.includes('A dialog was open on the page: confirm "Leave the shop?"') &&
    readme.includes('checkout broke: no card') && readme.includes('A dialog was in the way.') && !existsSync(join(out, 'screenshot.png')), readme);
  e = await session.evidence('t');
  check('the page as its client last read it stands in for its text, saying so',
    !!e.page?.includes('button "Place order"]') && e.title === 'Trail shop' && e.missing.some((m) => m.includes('page.txt is the page as it was last read')), JSON.stringify(e.missing));
  await session.answer('t', false);
  await session.click('t', ref('Freeze')).catch(() => {});
  const t0 = performance.now();
  e = await session.evidence();
  out = join(dir, 'stuck');
  writeBundle(out, e);
  readme = read(out, 'README.md');
  check(`a page stuck in a script: said so, quickly (${((performance.now() - t0) / 1000).toFixed(1)}s), with its console and requests`,
    performance.now() - t0 < 15000 && readme.includes('Not everything could be saved') && readme.includes("isn't answering") &&
    read(out, 'console.txt').includes('checkout broke') && read(out, 'network.txt').includes('/api/order') && !existsSync(join(out, 'screenshot.png')), readme);
} catch (err) {
  check('no errors', false, String((err as Error).stack ?? err));
} finally {
  await session.close();
}

// Medley's own folder of bundles keeps the newest, and touches nothing it didn't name.
const own = join(dir, 'own');
for (const name of ['2026-01-01-10-00-00-a', '2026-01-02-10-00-00-b', '2026-01-03-10-00-00-c', '2026-01-04-10-00-00-d', 'mine']) mkdirSync(join(own, name), { recursive: true });
writeFileSync(join(own, 'notes.txt'), 'kept');
const removed = pruneBundles(own, 2);
check('housekeeping: the oldest of its own go, the newest and everything else stay',
  removed === 2 && readdirSync(own).sort().join() === '2026-01-03-10-00-00-c,2026-01-04-10-00-00-d,mine,notes.txt', readdirSync(own).join());

// A replay that fails, from the command line.
const NAME = 'bundle-test';
const cli = join(import.meta.dir, '..', 'src', 'medley.ts');
const { PASSWORD: _, ...ENV } = process.env;
const run = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn([process.execPath, cli, '--session', NAME, '--no-color', ...args], { env: { ...ENV, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [o, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: (o + err).trim(), status };
};
await run(['stop']);
try {
  const script = join(dir, 'order.medley');
  const text = [
    '# buying shoes',
    `goto ${url('/shop')}`,
    'click button Add to cart',
    'expect --count 1 button Remove',
    'type "password Password" ${PASSWORD}',
    'click button Place order',
    'expect --within 1 Order placed',
    'click button Leave',
    '',
  ].join('\n');
  writeFileSync(script, text);
  const kept = join(dir, 'kept');
  let r = await run(['replay', script, '--bundle', kept], { PASSWORD: 'hunter2' });
  check('a failed replay says where what the page was is saved', r.status === 1 && r.out.includes('✗ 6 expect --within 1 Order placed') &&
    r.out.includes(`saved what the page was when the step failed to ${kept}: its README.md says what failed`), r.out);
  const files = existsSync(kept) ? readdirSync(kept).sort() : [];
  check('the folder: the README, the page as text, HTML and pictures, its console and requests, the script',
    files.join() === 'README.md,bundle.json,console.txt,network.txt,page.html,page.png,page.txt,screenshot.png,steps.medley', files.join());
  const readme = files.length ? read(kept, 'README.md') : '';
  check('the README: what failed, where in the script, and the page then', readme.startsWith('# A step failed: expect --within 1 Order placed') &&
    readme.includes('Step 6 of 7 of order.medley (line 7) failed') && readme.includes('expected "Order placed" on the page, but it isn\'t there') &&
    readme.includes(`The page then: **Trail shop** · ${url('/shop')} · window 1280×900 · tab 1 of 1`), readme);
  check('the steps done, the one that failed, the one not run, and how to run them again',
    readme.includes(`    ✓ 1 goto ${url('/shop')}`) && readme.includes('    ✓ 3 expect --count 1 button Remove · ok: there is 1 button called "Remove"') &&
    readme.includes('    ✗ 6 expect --within 1 Order placed') && readme.includes('    · 7 click button Leave (not run)') &&
    readme.includes('`medley replay steps.medley` (it reads PASSWORD from the environment)'), readme);
  check('the error the page logged and the request that failed', readme.includes('1 error (console.txt has all') && readme.includes('checkout broke: no card') &&
    readme.includes('1 of ') && /404 +GET http:\/\/127\.0\.0\.1:\d+\/api\/order/.test(readme), readme);
  const window = files.includes('screenshot.png') ? pngSize(join(kept, 'screenshot.png')) : null;
  const whole = files.includes('page.png') ? pngSize(join(kept, 'page.png')) : null;
  check('pictures: the window, and the whole page', window?.width === 1280 && window.height === 900 && whole?.width === 1280 && (whole?.height ?? 0) > 1500, JSON.stringify({ window, whole }));
  const pageText = files.includes('page.txt') ? read(kept, 'page.txt') : '';
  check('the page as text, and as HTML', pageText.startsWith('Trail shop\n') && pageText.includes('button "Remove"]') && pageText.includes('The end of the page') &&
    read(kept, 'page.html').includes('<button>Remove</button>') && read(kept, 'console.txt').includes('error    checkout broke: no card') && read(kept, 'network.txt').includes('/api/order'), pageText);
  const data = files.includes('bundle.json') ? JSON.parse(read(kept, 'bundle.json')) : {};
  check('as data', data.failure?.step === 6 && data.failure?.line === 7 && data.errors?.length === 1 && data.failed?.some((f: string) => f.includes('/api/order')) && data.files?.includes('page.png') && data.page === undefined, JSON.stringify(data).slice(0, 400));
  const all = files.filter((f) => !f.endsWith('.png')).map((f) => read(kept, f)).join('\n');
  check('the password typed is nowhere in it', !all.includes('hunter2') && pageText.includes('password "Password" = "********"') && read(kept, 'steps.medley') === text, pageText);

  r = await run(['replay', join(kept, 'steps.medley'), '--no-bundle'], { PASSWORD: 'hunter2' });
  check("the bundle's script fails the same way; --no-bundle saves nothing", r.status === 1 && r.out.includes('✗ 6 expect --within 1 Order placed') && !r.out.includes('saved what the page was'), r.out);
  r = await run(['replay', script], { PASSWORD: 'hunter2' });
  const where = /saved what the page was when the step failed to (.+?): its README/.exec(r.out)?.[1] ?? '';
  check("without --bundle it goes to medley's own folder, named for the time and the script", where.startsWith(BUNDLES) && /\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d-order$/.test(where) && existsSync(join(where, 'README.md')), r.out);
  if (where.startsWith(BUNDLES) && where.endsWith('-order')) rmSync(where, { recursive: true, force: true });
  writeFileSync(script, text.replace('expect --within 1 Order placed', 'expect Trail shoes').replace('click button Leave\n', ''));
  r = await run(['replay', script, '--bundle', join(dir, 'never')], { PASSWORD: 'hunter2' });
  check('a replay that passes saves nothing', r.status === 0 && !existsSync(join(dir, 'never')) && !r.out.includes('saved'), r.out);

  // bundle by itself: the page as it is, with a note.
  const now = join(dir, 'now');
  r = await run(['bundle', now, '--note', 'The cart shows shoes, but the order fails.']);
  const lines = r.out.split('\n');
  check('medley bundle <dir> --note: says what it saved', r.status === 0 && lines[0] === `saved the page as it is to ${now}` && lines.some((l) => /^ +README\.md +what the page was/.test(l)) &&
    lines.some((l) => /^ +network\.txt +every request it made: \d+ requests, 1 failed/.test(l)), r.out);
  const nowReadme = existsSync(join(now, 'README.md')) ? read(now, 'README.md') : '';
  check('its README: the page, the note, no steps', nowReadme.startsWith('# The page, as it was at ') && nowReadme.includes('The cart shows shoes, but the order fails.') &&
    !nowReadme.includes('## Steps') && !existsSync(join(now, 'steps.medley')) && existsSync(join(now, 'page.txt')), nowReadme);

  // Over MCP: a failed replay says where its bundle is; browser_bundle saves one.
  const mcp = spawn(process.execPath, [cli, '--session', NAME, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...ENV, PASSWORD: 'hunter2' } });
  const answers = new Map<number, (v: any) => void>();
  createInterface({ input: mcp.stdout! }).on('line', (line) => {
    const msg = JSON.parse(line);
    answers.get(msg.id)?.(msg);
  });
  const call = (id: number, method: string, params: object) =>
    new Promise<any>((resolve) => {
      answers.set(id, resolve);
      mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const said = (reply: any) => reply.result?.content?.map((c: { text: string }) => c.text).join('\n') ?? '';
  await call(1, 'initialize', {});
  const viaMcp = join(dir, 'mcp');
  let reply = await call(2, 'tools/call', { name: 'browser_replay', arguments: { script: text, bundle_dir: viaMcp } });
  check('over MCP: a failed replay is an error that says where its bundle is', reply.result?.isError === true && said(reply).includes(`saved what the page was when the step failed to ${viaMcp}`) &&
    existsSync(join(viaMcp, 'README.md')) && read(viaMcp, 'README.md').includes('of the script (line 7) failed'), said(reply));
  reply = await call(3, 'tools/call', { name: 'browser_replay', arguments: { script: text, bundle: false } });
  check('over MCP: bundle=false saves nothing', reply.result?.isError === true && !said(reply).includes('saved what the page was'), said(reply));
  const asked = join(dir, 'asked');
  reply = await call(4, 'tools/call', { name: 'browser_bundle', arguments: { dir: asked, note: 'Found while checking out.' } });
  check('over MCP: browser_bundle saves the page, with the note', !reply.result?.isError && said(reply).startsWith(`saved the page as it is to ${asked}`) &&
    read(asked, 'README.md').includes('Found while checking out.') && existsSync(join(asked, 'screenshot.png')), said(reply));
  mcp.kill();
} finally {
  await run(['stop']);
  rmSync(dir, { recursive: true, force: true });
  server.stop(true);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
