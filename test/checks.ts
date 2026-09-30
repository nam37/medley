// expect's checks, against a page served for them: text (there, gone, counted,
// in frames), elements counted by kind, the address and title, what fields
// hold, the states controls are in, and the errors a page logged; each both
// passing and failing, since a check that can't fail checks nothing. Then the
// same from the command line, recorded into a script, replayed, exported as
// a Playwright test, and asked for by an agent over MCP.
//
//   bun test/checks.ts

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Check } from '../src/checks.ts';
import { Session } from '../src/session.ts';

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    const page = PAGES[path.startsWith('/cart') ? '/cart' : path];
    return page ? new Response(page(server.port!), { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('not found', { status: 404 });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const PAGES: Record<string, (port: number) => string> = {
  '/cart': (port) => `<!doctype html><html lang="en"><title>Your cart · Trail Co-op</title>
<h1>Your cart</h1>
<ul>
  <li>Trail shoes <span>In stock</span> <button aria-label="Remove Trail shoes" onclick="this.parentElement.remove()">×</button></li>
  <li>Wool socks <span>In&nbsp;stock</span> <button aria-label="Remove Wool socks" onclick="this.parentElement.remove()">×</button></li>
  <li>Rain shell <span>In
    stock</span> <button aria-label="Remove Rain shell" onclick="this.parentElement.remove()">×</button></li>
</ul>
<form onsubmit="return false">
  <p><label>Email <input id="email" value="ada@example.com"></label></p>
  <p><label>Password <input id="pw" type="password" value="hunter2"></label></p>
  <p><label>Size <select id="size"><option value="s">Small</option><option value="l" selected>Large</option></select></label></p>
  <p><label><input type="checkbox" id="agree" onchange="order.disabled = !this.checked"> Agree to the terms</label></p>
  <p><button id="order" disabled onclick="setTimeout(placed, 700)">Place order</button></p>
</form>
<details><summary>Delivery</summary><p>Two days</p></details>
<p id="note">Not ordered yet</p>
<p><button onclick="console.error('checkout broke')">Break</button> <button onclick="fetch('/missing')">Fetch</button></p>
<iframe title="Offers" srcdoc="<p>Free shipping today</p>" width="300" height="60"></iframe>
<iframe title="Partner" src="http://localhost:${port}/partner" width="300" height="60"></iframe>
<script>
  function placed() {
    note.textContent = 'Order placed';
    history.pushState({}, '', '/cart/done');
    document.title = 'Thanks · Trail Co-op';
  }
</script>`,
  '/partner': () => `<!doctype html><p>Partner deals inside</p>`,
};

let failures = 0;
const check = (what: string, ok: boolean, got = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) {
    failures++;
    if (got) console.log(got.split('\n').map((l) => `     | ${l}`).join('\n'));
  }
};
const attempt = (p: Promise<string>) => p.then((text) => text, (e: Error) => `error: ${e.message}`);
const seconds = (t0: number) => (performance.now() - t0) / 1000;

const session = await Session.start();
try {
  const expect = (checks: Check[], wait = 1) => attempt(session.expect('t', checks, wait));
  const passes = (r: string, ...has: string[]) => !r.startsWith('error:') && has.every((h) => r.includes(h));
  const fails = (r: string, ...has: string[]) => r.startsWith('error: ') && has.every((h) => r.includes(h));
  const page = await session.goto('t', url('/cart'));
  const ref = (pattern: RegExp) => String(pattern.exec(page)?.[1] ?? NaN);

  // Text: there, gone, counted (whitespace of any kind is a space), in frames too.
  let r = await expect([{ kind: 'text', text: 'your cart' }]);
  check('text on the page, in any case, and where it is', passes(r, 'ok: "your cart" is on the page', '# Your cart'), r);
  r = await expect([{ kind: 'text', text: 'Order placed' }]);
  check("text that isn't there fails, saying what page it looked at", fails(r, 'expected "Order placed" on the page, but it isn\'t there (after 1s; the page is "Your cart · Trail Co-op"'), r);
  r = await expect([{ kind: 'count', text: 'In stock', n: 3 }]);
  check('a count of text, across a line break and a non-breaking space', passes(r, '"In stock" is on the page 3 times'), r);
  r = await expect([{ kind: 'count', text: 'In stock', n: 2 }]);
  check('a wrong count fails with the right one', fails(r, 'expected "In stock" 2 times, but it\'s on the page 3 times'), r);
  r = await expect([{ kind: 'text', text: 'Free shipping today' }, { kind: 'text', text: 'Partner deals inside' }]);
  check("text in a frame, from this site or another, is on the page", passes(r, '"Free shipping today" is on the page', '"Partner deals inside" is on the page'), r);
  r = await expect([{ kind: 'text', text: 'Partner deals', gone: true }]);
  check("and isn't gone", fails(r, 'expected "Partner deals" to be gone, but it\'s still on the page'), r);

  // Elements counted by kind: their names as snapshots show them.
  r = await expect([{ kind: 'count', text: 'button Remove', n: 3 }]);
  check('a count of buttons by name', passes(r, 'there are 3 buttons called "Remove"'), r);
  r = await expect([{ kind: 'count', text: 'button Remove', n: 2 }]);
  check('a wrong count lists them', fails(r, 'expected 2 buttons called "Remove", but there are 3 buttons called "Remove": [', 'button "Remove Trail shoes"]'), r);
  r = await expect([{ kind: 'count', text: 'checkbox', n: 1 }, { kind: 'count', text: 'radio', n: 0 }]);
  check('a count of a kind, and of none', passes(r, 'there is 1 checkbox', 'there are no radio buttons'), r);

  // The address and the title.
  r = await expect([{ kind: 'url', text: '/cart' }, { kind: 'title', text: 'your CART' }]);
  check('the address has text, and the title does in any case', passes(r, `the address has "/cart" (${url('/cart')})`, 'the title has "your CART"'), r);
  r = await expect([{ kind: 'url', text: '/Cart' }]);
  check('the address is matched exactly', fails(r, `expected the address to have "/Cart", but it's ${url('/cart')}`), r);
  r = await expect([{ kind: 'title', text: 'Checkout' }]);
  check('a wrong title fails with the right one', fails(r, 'expected the title to have "Checkout", but it\'s "Your cart · Trail Co-op"'), r);

  // What fields hold.
  r = await expect([{ kind: 'value', ref: 'textbox Email', text: 'ada@example.com' }, { kind: 'value', ref: ref(/\[(\d+) select "Size"/), text: 'large' }]);
  check('a field by name holds its text; a select by number, its option', passes(r, 'textbox "Email"] holds "ada@example.com"', 'select "Size"] holds "Large"'), r);
  r = await expect([{ kind: 'value', ref: 'Size', text: 'l' }, { kind: 'value', ref: 'checkbox Agree', text: 'off' }]);
  check("a select's option by its value; a checkbox off", passes(r, 'holds "Large"', 'checkbox "Agree to the terms"] is unchecked'), r);
  r = await expect([{ kind: 'value', ref: 'Email', text: 'ada@example.co' }]);
  check('a wrong value fails with the right one', fails(r, 'textbox "Email"] to hold "ada@example.co", but it holds "ada@example.com"'), r);
  r = await expect([{ kind: 'value', ref: 'password Password', text: 'hunter2' }]);
  check("a password is checked without being shown", passes(r, 'password "Password"] holds the text given') && !r.includes('hunter2'), r);
  r = await expect([{ kind: 'value', ref: 'password Password', text: 'swordfish' }]);
  check('nor shown when wrong', fails(r, 'to hold the text given, but it holds something else') && !/hunter2|swordfish/.test(r), r);
  r = await expect([{ kind: 'value', ref: 'button Place order', text: 'x' }]);
  check("a button holds nothing", fails(r, "but it isn't a field"), r);

  // The states controls are in.
  r = await expect([
    { kind: 'state', ref: 'button Place order', state: 'disabled' },
    { kind: 'state', ref: 'Agree', state: 'unchecked' },
    { kind: 'state', ref: 'Delivery', state: 'collapsed' },
    { kind: 'state', ref: 'Email', state: 'enabled' },
  ]);
  check('disabled, unchecked, collapsed, enabled', passes(r, 'button "Place order"] is disabled', 'is unchecked', 'is collapsed', 'textbox "Email"] is enabled'), r);
  r = await expect([{ kind: 'state', ref: 'button Place order', state: 'enabled' }, { kind: 'state', ref: 'Place order', state: 'checked' }]);
  check('states that are not so say what is', fails(r, "to be enabled, but it's disabled", "to be checked, but it isn't a checkbox or a radio button"), r);
  await session.type('t', Number(ref(/\[(\d+) textbox "Email"/)), 'ada@example.com');
  r = await expect([{ kind: 'state', ref: 'Email', state: 'focused' }]);
  check('the focus is on the field typed into', passes(r, 'textbox "Email" = "ada@example.com" focused] is focused') || passes(r, 'is focused'), r);
  r = await expect([{ kind: 'state', ref: 'password Password', state: 'focused' }]);
  check('and not on another, which says where it is', fails(r, 'password "Password"] to be focused, but the focus is on [', 'textbox "Email"'), r);
  r = await expect([{ kind: 'state', ref: 'button Pay now', state: 'enabled' }]);
  check('an element that is not on the page', fails(r, 'expected "button Pay now" to be enabled, but nothing on the page is called that'), r);
  r = await expect([{ kind: 'state', ref: 'Remove', state: 'enabled' }]);
  check('a name that fits several is an error at once, listing them', fails(r, 'fits') && !r.includes('after 1s'), r);

  // Errors: none so far; then one logged, and a request that failed.
  r = await expect([{ kind: 'errors' }]);
  check('no errors yet', passes(r, 'the page logged no errors'), r);
  await session.click('t', await session.resolveRef('t', 'button Break'));
  r = await expect([{ kind: 'errors' }, { kind: 'text', text: 'Your cart' }]);
  check('an error the page logged fails the check; what passed is said too', fails(r, 'expected no errors, but the page logged 1 error: checkout broke', 'ok: "Your cart" is on the page'), r);
  await session.click('t', await session.resolveRef('t', 'button Fetch'));
  r = await expect([{ kind: 'errors' }]);
  check('and so does a request of its own that failed', fails(r, '1 request failed: 404 GET /missing'), r);

  // Waiting: checks pass as soon as the page gets there, all together.
  await session.fill('t', [{ ref: await session.resolveRef('t', 'checkbox Agree'), value: 'on' }]);
  r = await expect([{ kind: 'state', ref: 'button Place order', state: 'enabled' }, { kind: 'state', ref: 'Agree', state: 'checked' }]);
  check('after agreeing, the button is enabled', passes(r, 'is enabled', 'is checked'), r);
  await session.click('t', await session.resolveRef('t', 'button Place order'));
  const t0 = performance.now();
  r = await expect([{ kind: 'text', text: 'Order placed' }, { kind: 'url', text: '/cart/done' }, { kind: 'title', text: 'Thanks' }, { kind: 'text', text: 'Not ordered yet', gone: true }], 5);
  check(`what comes a moment later is waited for (${seconds(t0).toFixed(1)}s)`, passes(r, '"Order placed" is on the page', '/cart/done', 'the title has "Thanks"', '"Not ordered yet" isn\'t on the page') && seconds(t0) < 4, r);

  // A removed item: counts follow the page.
  await session.click('t', await session.resolveRef('t', 'button Remove Wool socks'));
  r = await expect([{ kind: 'count', text: 'button Remove', n: 2 }, { kind: 'count', text: 'In stock', n: 2 }, { kind: 'text', text: 'Wool socks', gone: true }]);
  check('after removing one, there are two', passes(r, 'there are 2 buttons called "Remove"', '"In stock" is on the page 2 times'), r);
} catch (e) {
  check('no errors', false, String((e as Error).stack ?? e));
} finally {
  await session.close();
}

// From the command line, in a session: options for each check, several in one; recorded, replayed, exported.
const NAME = 'checks-test';
const OTHER = 'checks-test-replay';
const cli = join(import.meta.dir, '..', 'src', 'medley.ts');
const { PASSWORD: _, ...ENV } = process.env;
// Not spawnSync: the pages are served from this process, which must keep answering while medley runs.
const run = async (session: string, args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn([process.execPath, cli, '--session', session, '--no-color', ...args], { env: { ...ENV, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: (out + err).trim(), status };
};
const medley = (...args: string[]) => run(NAME, args);
const dir = join(tmpdir(), 'medley-checks-test');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
await medley('stop');
await run(OTHER, ['stop']);
try {
  await medley('goto', url('/cart'));
  let r = await medley('expect', '--url', '/cart', '--count', '3', 'button', 'Remove');
  check('expect --url --count: both, a line each', r.status === 0 && r.out === `ok: there are 3 buttons called "Remove"\nok: the address has "/cart" (${url('/cart')})`, r.out);
  r = await medley('expect', '--disabled', 'button Place order', '--value', 'textbox Email=ada@example.com', '--no-errors', '--title', 'cart');
  check('expect --disabled --value --no-errors --title', r.status === 0 && r.out.split('\n').length === 4 && r.out.split('\n').every((l) => l.startsWith('ok: ')), r.out);
  r = await medley('expect', '--within', '1', '--enabled', 'Place order', 'Your cart');
  check('one that fails: exit status 1, what failed first, then what passed',
    r.status === 1 && r.out.startsWith('medley: expected [') && r.out.includes("to be enabled, but it's disabled (after 1s") && r.out.endsWith('ok: "Your cart" is on the page'), r.out);
  r = await medley('expect');
  check('expect with nothing to check is a usage error', r.status === 2 && r.out.includes('usage: expect <text>'), r.out.slice(0, 300));
  r = await medley('expect', '--count', 'three', 'Remove');
  check('so is a count that is not a number', r.status === 2 && r.out.includes(`"three" isn't a count`), r.out.slice(0, 300));

  // Recorded as they were asked, elements by kind and name, a password left out.
  const script = join(dir, 'order.medley');
  await medley('record', 'start', script);
  await medley('expect', '--disabled', 'Place order', '--count', '3', 'button', 'Remove');
  await medley('fill', 'checkbox Agree=on');
  await medley('expect', '--value', 'Password=hunter2', '--value', 'Size=Large', '--checked', 'Agree');
  await medley('click', 'button', 'Place order');
  await medley('expect', '--within', '8', '--url', '/cart/done', '--title', 'Thanks', '--no-errors', 'Order', 'placed');
  await medley('expect', '--gone', 'Not ordered yet');
  const out = (await medley('record', 'stop')).out;
  const steps = [
    `goto ${url('/cart')}`,
    'expect --count 3 --disabled "button Place order" button Remove',
    'fill "checkbox Agree to the terms=on"',
    'expect --value "password Password=${PASSWORD}" --value "select Size=Large" --checked "checkbox Agree to the terms"',
    'click button Place order',
    'expect --url /cart/done --title Thanks --no-errors --within 8 Order placed',
    'expect --gone "Not ordered yet"',
  ];
  check('recorded: the checks as steps, elements by kind and name, the password as ${PASSWORD}', out.endsWith(steps.join('\n')) && !out.includes('hunter2'), out);
  r = await run(OTHER, ['replay', script], { PASSWORD: 'hunter2' });
  check('replayed in a fresh session: every step passes', r.status === 0 && (r.out.match(/^✓ /gm) ?? []).length === 7, r.out);
  r = await run(OTHER, ['replay', script], { PASSWORD: 'wrong' });
  check('with the wrong password, the check of it fails and stops the replay', r.status === 1 && r.out.includes('✗ 4 expect --value') && r.out.includes('holds something else') && !r.out.includes('hunter2'), r.out);
  const test = (await run(NAME, ['playwright', script])).out;
  const has = (line: string) => test.includes(line);
  check('as a Playwright test: counts, states and values',
    has(`await expect(page.getByRole('button', { name: "Remove" })).toHaveCount(3);`) &&
    has(`await expect(page.getByRole('button', { name: "Place order" })).toBeDisabled();`) &&
    has(`await expect(page.getByLabel("Password")).toHaveValue((process.env.PASSWORD ?? ''));`) &&
    has(`await expect(page.getByRole('combobox', { name: "Size" }).locator('option:checked')).toHaveText("Large");`) &&
    has(`await expect(page.getByRole('checkbox', { name: "Agree to the terms" })).toBeChecked();`), test);
  check('the address, the title, no errors, with the time allowed',
    has('await expect.poll(() => page.url(), { timeout: 8000 }).toContain("/cart/done");') &&
    has('await expect.poll(async () => (await page.title()).toLowerCase(), { timeout: 8000 }).toContain("Thanks".toLowerCase());') &&
    has("page.on('pageerror', (e) => errors.push(String(e)));") && has("expect(errors, 'errors the page logged').toEqual([]);") &&
    has('await expect(page.getByText("Order placed").first()).toBeVisible({ timeout: 8000 });') &&
    has('await expect(page.getByText("Not ordered yet").first()).toBeHidden();'), test);

  // An agent's checks over MCP: several things in one call; one not so is an error saying what is.
  await medley('goto', url('/cart'));
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
  const text = (reply: any) => reply.result?.content?.map((c: { text: string }) => c.text).join('\n') ?? '';
  await call(1, 'initialize', {});
  let reply = await call(2, 'tools/call', {
    name: 'browser_expect',
    arguments: {
      text: 'In stock',
      count: 3,
      url: '/cart',
      fields: [{ ref: 'textbox Email', value: 'ada@example.com' }, { ref: 'checkbox Agree', value: 'off' }],
      states: [{ ref: 'button Place order', is: 'disabled' }],
      no_errors: true,
    },
  });
  check('over MCP: text counted, the address, fields, states and no errors in one call', !reply.result?.isError && text(reply).split('\n').length === 6 && text(reply).split('\n').every((l: string) => l.startsWith('ok: ')), text(reply));
  reply = await call(3, 'tools/call', { name: 'browser_expect', arguments: { states: [{ ref: 'button Place order', is: 'enabled' }], seconds: 1 } });
  check('over MCP: a state that is not so is an error', reply.result?.isError === true && text(reply).includes("to be enabled, but it's disabled"), text(reply));
  reply = await call(4, 'tools/call', { name: 'browser_expect', arguments: {} });
  check('over MCP: nothing to check is an error that says what can be', reply.result?.isError === true && text(reply).includes('usage: expect'), text(reply));
  mcp.kill();
} finally {
  await medley('stop');
  await run(OTHER, ['stop']);
  rmSync(dir, { recursive: true, force: true });
  server.stop(true);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
