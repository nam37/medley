// Checks after each save: `watch --check` runs a script after every reload
// and says what failed, what the save broke and what it fixed; a failed
// expect doesn't stop the rest, a failed action does; checks that leave the
// page don't confuse the next save's diff. Then the same for an agent
// (browser_reload with checks), and replay --keep-going.
//
//   bun test/watch.ts

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const NAME = 'watch-test';
const cli = join(import.meta.dir, '..', 'src', 'medley.ts');
const { TOKEN: _, ...ENV } = process.env;
const run = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn([process.execPath, cli, '--session', NAME, '--no-color', ...args], { env: { ...ENV, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: (out + err).trim(), status };
};

let failures = 0;
const check = (what: string, ok: boolean, got = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures++;
    if (got) console.log(got.split('\n').map((l) => `     | ${l}`).join('\n'));
  }
};

const dir = join(tmpdir(), 'medley-watch-test');
rmSync(dir, { recursive: true, force: true });
const site = join(dir, 'site');
mkdirSync(site, { recursive: true });
const index = join(site, 'index.html');
const checks = join(dir, 'checks.medley'); // beside the site, so saving it isn't a change to the site
/** The shop: its items, its total, whether it has its Add button, and a script of its own. */
const html = ({ items = ['Tent', 'Stove'], total = '$10', add = true, script = '' } = {}) => `<!doctype html><html lang="en"><title>Shop</title><main><h1>Shop</h1>
${items.map((i) => `<p><a href="details.html">Item ${i}</a></p>`).join('\n')}
<p>Total: ${total}</p>
${add ? `<p><button onclick="out.textContent = 'Added'">Add</button> <span id="out"></span></p>` : ''}
</main><script>${script}</script>`;
writeFileSync(index, html());
writeFileSync(join(site, 'details.html'), '<!doctype html><title>Details</title><h1>Details page</h1>');
writeFileSync(checks, [
  '# what the shop has to keep doing',
  'expect --no-errors',
  'expect --count 2 link Item',
  'expect Total: $10',
  'click button Add',
  'expect Added',
  'click link Item Tent',
  'expect Details page',
  '',
].join('\n'));

await run(['stop']);
let watcher: ReturnType<typeof spawn> | undefined;
try {
  // What can't run says so before watching.
  await run(['goto', pathToFileURL(index).href]);
  let r = await run(['watch', site, '--check', join(dir, 'nope.medley')]);
  check('a checks script that is not there: said at once', r.status === 1 && /nope\.medley/.test(r.out) && !r.out.includes('watching'), r.out);
  const needy = join(dir, 'needy.medley');
  writeFileSync(needy, 'expect ${TOKEN}\n');
  r = await run(['watch', site, '--check', needy]);
  check('one that reads a name the environment lacks: said at once', r.status === 1 && r.out.includes('reads TOKEN from the environment'), r.out);

  watcher = spawn(process.execPath, [cli, '--session', NAME, '--no-color', 'watch', site, '--check', checks], { stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
  let seen = '';
  watcher.stdout!.on('data', (d) => (seen += d));
  watcher.stderr!.on('data', (d) => (seen += d));
  const until = async (test: () => boolean, ms = 40000) => {
    for (const end = Date.now() + ms; Date.now() < end && !test(); ) await Bun.sleep(100);
    return test();
  };
  /** Save the page, and wait for the checks that follow: what was printed from the save on. */
  const save = async (page: string) => {
    const from = seen.length;
    writeFileSync(index, page);
    await until(() => seen.slice(from).includes('\nchecks: '));
    await Bun.sleep(300); // the rest of what the run said
    return seen.slice(from);
  };

  await until(() => /checks: .*\n/.test(seen));
  check('at the start: it says what it runs, and how the checks stand', seen.includes('and running checks.medley') && /checks: all 7 passed \(checks\.medley, [\d.]+s\)/.test(seen), seen);

  let out = await save(html({ items: ['Tent'] }));
  check('a save that breaks a check: the diff, then the check, as broken by this save', /index\.html changed · reloaded · \+0 -1 lines/.test(out) && out.includes('- [2]Item Stove') &&
    /checks: 1 of 7 failed/.test(out) && out.includes('✗ 2 expect --count 2 link Item · broken by this save') && out.includes('    expected 2 links called "Item", but there is 1 link called "Item"'), out);
  check('the checks after the failed one still ran, and those that pass are not listed', !out.includes('not run') && !out.includes('expect Added') && !out.includes('✓'), out);
  check("what the checks did to the page isn't taken for the save's doing", !out.includes('Added') && !out.includes('Details page'), out);

  out = await save(html({ items: ['Tent'], script: 'console.error("cart.js broke")' }));
  check('another break: one new, one still failing', /checks: 2 of 7 failed/.test(out) && out.includes('✗ 1 expect --no-errors · broken by this save') && out.includes('cart.js broke') &&
    out.includes('✗ 2 expect --count 2 link Item · still failing'), out);

  out = await save(html({ total: '$12' }));
  check('a save that fixes them and breaks another: each said', /checks: 1 of 7 failed/.test(out) && out.includes('✓ 1 expect --no-errors · fixed by this save') &&
    out.includes('✓ 2 expect --count 2 link Item · fixed by this save') && out.includes('✗ 3 expect Total: $10 · broken by this save'), out);

  out = await save(html({ add: false }));
  check('a failed action stops the steps after it, which are said not to have run', /checks: 1 of 4 failed/.test(out) && out.includes('✓ 3 expect Total: $10 · fixed by this save') &&
    out.includes('✗ 4 click button Add · broken by this save') && out.includes('· 3 steps not run: step 4 has to work first'), out);

  out = await save(html());
  check('all fixed: all passed, with what was fixed', /checks: all 7 passed/.test(out) && out.includes('✓ 4 click button Add · fixed by this save') && !out.includes('✗'), out);
  check('every save was told against the watched page, though the checks leave it', !/page changed substantially|→ new page/.test(seen), seen);
  watcher.kill();
  watcher = undefined;

  // replay --keep-going: every check tried.
  writeFileSync(index, html({ items: ['Tent'], total: '$12' }));
  await run(['goto', pathToFileURL(index).href]);
  r = await run(['replay', checks, '--keep-going']);
  check('replay --keep-going: both failed checks told, the rest run, exit status 1', r.status === 1 && r.out.includes('✗ 2 expect --count 2 link Item') && r.out.includes('✗ 3 expect Total: $10') &&
    r.out.includes('✓ 7 expect Details page') && r.out.includes('2 of 7 steps failed') && !r.out.includes('saved what the page was'), r.out);
  r = await run(['replay', checks, '--no-bundle']);
  check('without it, replay stops at the first', r.status === 1 && r.out.includes('stopped at step 2 of 7') && !r.out.includes('✗ 3'), r.out);

  // An agent's loop: reload with checks, one call per edit.
  await run(['goto', pathToFileURL(index).href]);
  const mcp = spawn(process.execPath, [cli, '--session', NAME, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'], env: ENV });
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
  await call(2, 'tools/call', { name: 'browser_snapshot', arguments: {} });
  const asked = 'expect --no-errors\nexpect --count 2 link Item\nexpect Total: $10';
  let reply = await call(3, 'tools/call', { name: 'browser_reload', arguments: { diff: true, checks: asked } });
  check('over MCP: reload with checks that fail is an error saying which', reply.result?.isError === true && said(reply).startsWith('reloaded') &&
    said(reply).includes('checks: 2 of 3 failed') && said(reply).includes('✗ 2 expect --count 2 link Item') && !said(reply).includes('this reload'), said(reply));
  writeFileSync(index, html({ total: '$12' }));
  reply = await call(4, 'tools/call', { name: 'browser_reload', arguments: { diff: true, checks: asked } });
  check('after an edit: the diff, what this reload fixed, and what still fails', reply.result?.isError === true && said(reply).includes('Item Stove') &&
    said(reply).includes('✓ 2 expect --count 2 link Item · fixed by this reload') && said(reply).includes('✗ 3 expect Total: $10 · still failing'), said(reply));
  writeFileSync(index, html());
  reply = await call(5, 'tools/call', { name: 'browser_reload', arguments: { diff: true, checks: asked } });
  check('and when all pass, no error', !reply.result?.isError && said(reply).includes('checks: all 3 passed') && said(reply).includes('✓ 3 expect Total: $10 · fixed by this reload'), said(reply));
  reply = await call(6, 'tools/call', { name: 'browser_replay', arguments: { script: `${asked}\nexpect Nothing like it --within 1\nexpect Shop`, keep_going: true } });
  check('over MCP: replay with keep_going tries every check', reply.result?.isError === true && said(reply).includes('✗ 4 expect Nothing like it') && said(reply).includes('✓ 5 expect Shop') && said(reply).includes('1 of 5 steps failed'), said(reply));
  mcp.kill();
} finally {
  watcher?.kill();
  await run(['stop']);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
