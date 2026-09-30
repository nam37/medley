// inspect, against a page served for it with its own stylesheet and script:
// an element's markup, where it sits and a selector for it, its name and
// where that comes from, its box, why it can't be seen or clicked when it
// can't, its styles, the CSS rules behind them and the listeners that hear
// it, each with its file and line; in frames and a shadow root too. Then a
// picture of just the element from the command line, and over MCP.
//
//   bun test/inspect.ts

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Session } from '../src/session.ts';

const CSS = `body { font-family: Georgia, serif; color: #1f2a33; margin: 0 }
.actions { display: flex; gap: 12px; align-items: center }
.btn {
  padding: 8px 16px;
  border: 1px solid #0a7d5e;
  border-radius: 6px;
  colour: red;
}
.btn.primary { background: #0a7d5e; color: #ffffff }
button:disabled { opacity: 0.5; cursor: not-allowed }
@media (min-width: 600px) {
  .btn { font-weight: 600 }
}
.ghost { pointer-events: none }
.modal { display: none }
.banner { position: fixed; left: 0; right: 0; bottom: 0; height: 120px; background: #222; color: #fff }
`;

const JS = `const order = document.getElementById('order');
order.addEventListener('click', () => { out.textContent = 'ordered'; });
document.getElementById('checkout').addEventListener('click', (e) => {
  if (e.target.matches('.remove')) out.textContent = 'removed';
});
document.addEventListener('keydown', () => {});
`;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/app.css') return new Response(CSS, { headers: { 'content-type': 'text/css' } });
    if (path === '/app.js') return new Response(JS, { headers: { 'content-type': 'text/javascript' } });
    const page = PAGES[path];
    return page ? new Response(page(server.port!), { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('not found', { status: 404 });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const PAGES: Record<string, (port: number) => string> = {
  '/': (port) => `<!doctype html><html lang="en"><title>Checkout</title>
<link rel="stylesheet" href="/app.css">
<style>
  #save { color: #999999 }
</style>
<main>
  <h1>Checkout</h1>
  <form id="checkout" onsubmit="return false">
    <p><label>Email <input id="email" placeholder="you@example.com"></label></p>
    <p><label>Password <input id="pw" type="password" value="hunter2"></label></p>
    <p><input id="coupon" placeholder="Coupon code"></p>
    <p class="actions">
      <button id="order" class="btn primary" type="button">Place order</button>
      <button id="save" class="btn" type="button" disabled>Save for later</button>
      <button class="btn remove" type="button" aria-label="Remove Trail shoes" data-testid="remove-shoes">×</button>
      <button class="btn ghost" type="button" onclick="out.textContent = 'ghost'">Ghost</button>
    </p>
  </form>
  <div class="modal"><button id="confirm">Confirm</button></div>
  <p id="out"></p>
  <x-card></x-card>
  <iframe title="Offers" srcdoc="<button style='margin: 10px'>Claim offer</button>" width="300" height="70"></iframe>
  <iframe title="Partner" src="http://localhost:${port}/partner" width="300" height="70"></iframe>
  <div style="height: 900px"></div>
  <p><a id="terms" href="/terms">Terms</a> <button id="under" class="btn">Under the banner</button></p>
</main>
<div class="banner">We use cookies <button id="ok">OK</button></div>
<script src="/app.js"></script>
<script>
  customElements.define('x-card', class extends HTMLElement {
    connectedCallback() {
      this.attachShadow({ mode: 'open' }).innerHTML = '<style>button { color: #aa0000 }</style><button part="go">In the shadow</button>';
    }
  });
</script>`,
  '/partner': () => `<!doctype html><style>a { color: #663399 }</style><p style="margin: 20px"><a href="/deal">Partner deal</a></p>`,
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
/** The lines of a report under one name: `rules`, then the unnamed lines after it. */
const part = (report: string, name: string) => {
  const lines = report.split('\n');
  const at = lines.findIndex((l) => l.startsWith(name.padEnd(10)));
  if (at < 0) return '';
  let end = at + 1;
  while (end < lines.length && lines[end].startsWith(' '.repeat(10))) end++;
  return lines.slice(at, end).join('\n');
};

const session = await Session.start();
try {
  await session.goto('t', url('/'));
  const inspect = async (name: string, opts = {}) => attempt(session.inspect('t', await session.resolveRef('t', name), opts));

  // A button: what it is, where it is, how it looks, and where that's written.
  let r = await inspect('button Place order');
  check('its label as snapshots show it, then its opening tag', r.split('\n')[0].endsWith('button "Place order"]') && r.split('\n')[1] === '<button id="order" class="btn primary" type="button">', r);
  check('where it sits, and a selector that finds only it', part(r, 'in').includes('body › main › form#checkout › p.actions') && part(r, 'selector').endsWith(' #order'), r);
  check('its name and where that comes from, and its role', part(r, 'name').includes('"Place order", from its text · role button (from its tag)'), r);
  check('its box, in the window, seen and clickable', /box\s+\d+(\.\d+)?×\d+(\.\d+)? at \d+(\.\d+)?,\d+(\.\d+)? · in the window/.test(r) && part(r, 'visible').endsWith(' yes') && part(r, 'clickable').endsWith(' yes'), r);
  check('its colors with their contrast, and its font', part(r, 'colors').includes('#ffffff on #0a7d5e · contrast 5.1:1') && /font\s+600 13\.3px\/normal \w+/.test(part(r, 'font')), r);
  check('its layout: its own, and as an item of a flex row', part(r, 'layout').includes('padding 8px 16px') && part(r, 'layout').includes('border 1px solid #0a7d5e') && part(r, 'layout').includes('border-radius 6px') &&
    part(r, 'layout').includes('an item of p.actions (flex row, align-items center, gap 12px): flex 0 1 auto'), r);
  let rules = part(r, 'rules');
  check('the rules behind it, strongest first, with file and line', rules.indexOf('.btn.primary { background: #0a7d5e; color: #ffffff }  app.css:9') > 0 &&
    rules.indexOf('.btn.primary') < rules.indexOf('.btn { padding: 8px 16px') && rules.includes('app.css:3'), rules);
  check('a rule in a media query; a declaration the browser ignored', rules.includes('@media (min-width: 600px) .btn { font-weight: 600 }  app.css:12') && rules.includes('colour: red (not valid: ignored)'), rules);
  check("rules it inherits from, named by what they're on; not the browser's own", rules.includes('from body: body { font-family: Georgia, serif; color: #1f2a33 }  app.css:1') && !rules.includes('margin: 0') && !rules.includes('user agent'), rules);
  let heard = part(r, 'listeners');
  check('the listener on it, and the one on the form around it, with file and line', heard.includes('click  app.js:2') && heard.includes('click, on form#checkout  app.js:3'), heard);
  check("a key listener on the document; the form's inline onsubmit, in the page itself", heard.includes('keydown, on the document  app.js:6') && heard.includes('submit, on form#checkout  (this page):8'), heard);
  check('its markup', part(r, 'html').endsWith('<button id="order" class="btn primary" type="button">Place order</button>'), r);

  // Why something can't be clicked, or seen.
  r = await inspect('button Save for later');
  check('disabled: its state, not clickable, and the rule that dims it', part(r, 'states').includes('disabled') && part(r, 'clickable').endsWith("no: it's disabled") &&
    part(r, 'other').includes('cursor not-allowed') && part(r, 'other').includes('opacity 0.5') && part(r, 'rules').includes('button:disabled { opacity: 0.5; cursor: not-allowed }  app.css:10'), r);
  check('a rule from a <style> in the page, with the page as its file', part(r, 'rules').includes('#save { color: #999999 }  (this page):4'), part(r, 'rules'));
  r = await inspect('button Ghost');
  check('pointer-events: none: clicks go through it', part(r, 'clickable').includes('pointer-events is none') && part(r, 'other').includes('pointer-events none') &&
    part(r, 'listeners').includes('click  ') && r.includes('onclick="out.textContent = \'ghost\'"'), r);
  r = await inspect('button Remove');
  check('a name from aria-label; a selector by its test id; listeners only around it', part(r, 'name').includes('"Remove Trail shoes", from its aria-label') &&
    part(r, 'selector').endsWith('button[data-testid="remove-shoes"]') && part(r, 'listeners').includes('none on it itself; around it:') && part(r, 'listeners').includes('click, on form#checkout  app.js:3'), r);
  r = await inspect('button Under the banner');
  check('below the window: says so, and scrolls nothing', part(r, 'box').includes('below the window') && part(r, 'clickable').includes("outside the window") &&
    (await session.snapshot('t')).includes('viewport 0–'), r);
  await session.scroll('t', 'bottom');
  r = await inspect('button Under the banner');
  check('scrolled to, under a banner: covered, by what', part(r, 'clickable').includes('no: it is covered by') && part(r, 'clickable').includes('We use cookies'), r);
  await session.scroll('t', 'top');

  // Fields: what they hold, and a password kept to itself.
  r = await inspect('textbox Coupon');
  check('a name that is only a placeholder says so', part(r, 'name').includes('"Coupon code", from its placeholder, which goes when typing starts: not a label · role textbox') && part(r, 'value').endsWith('(empty)'), r);
  r = await inspect('password Password');
  check("a password's value is masked everywhere", part(r, 'value').endsWith('"********"') && !r.includes('hunter2') && r.includes('value="********"'), r);
  r = await attempt(session.inspect('t', await session.resolveRef('t', 'password Password'), { json: true }));
  check('as data too', !r.includes('hunter2') && JSON.parse(r).name === 'Password' && JSON.parse(r).from === 'label' && Array.isArray(JSON.parse(r).rules), r.slice(0, 300));

  // More properties, asked for by name.
  r = await inspect('button Place order', { css: ['min-width', 'not-a-thing'] });
  check('--css: more properties', part(r, 'css').includes('min-width: ') && part(r, 'css').includes('not-a-thing: (not a property it has)'), part(r, 'css'));

  // In a shadow root, in a frame of this site, and in a frame from another.
  r = await inspect('button In the shadow');
  check('in a shadow root: its host, and the rule from the shadow\'s own style', part(r, 'in').includes('x-card') && part(r, 'in').includes('(the shadow root of x-card)') && part(r, 'rules').includes('button { color: #aa0000 }'), r);
  r = await inspect('button Claim offer');
  const offer = /box\s+[\d.]+×[\d.]+ at ([\d.]+),([\d.]+)/.exec(r);
  check('in a frame of this site: placed where the frame is', !!offer && Number(offer[1]) > 10 && Number(offer[2]) > 100 && part(r, 'clickable').endsWith(' yes'), r);
  r = await inspect('link Partner deal');
  const deal = /box\s+[\d.]+×[\d.]+ at ([\d.]+),([\d.]+)/.exec(r);
  check('in a frame from another site: says so, placed in the page, with its own rules', part(r, 'in').includes('in a frame from another site') && !!deal && Number(deal[1]) > 300 && Number(deal[2]) > 100 &&
    part(r, 'rules').includes('a { color: #663399 }') && part(r, 'colors').includes('#663399'), r);

  r = await attempt(session.inspect('t', 9999));
  check("a ref that isn't on the page is an error", r.startsWith('error:') && r.includes("isn't on the page"), r);
} catch (e) {
  check('no errors', false, String((e as Error).stack ?? e));
} finally {
  await session.close();
}

// From the command line and over MCP: the report, and a picture of just the element.
const NAME = 'inspect-test';
const cli = join(import.meta.dir, '..', 'src', 'medley.ts');
const run = async (args: string[]) => {
  const p = Bun.spawn([process.execPath, cli, '--session', NAME, '--no-color', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out: (out + err).trim(), status };
};
const dir = join(tmpdir(), 'medley-inspect-test');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
await run(['stop']);
/** A PNG's width and height, from its header. */
const pngSize = (png: Buffer) => (png.subarray(1, 4).toString() === 'PNG' ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null);
try {
  await run(['goto', url('/')]);
  const file = join(dir, 'order.png');
  let r = await run(['inspect', 'Place', 'order', '--shot', file]);
  const size = existsSync(file) ? pngSize(readFileSync(file)) : null;
  check('medley inspect <name> --shot <file>: the report, and a picture of just the button, at twice its size',
    r.status === 0 && r.out.includes('selector   #order') && r.out.includes(`saved to ${file}`) && !!size && size.width > 150 && size.width < 500 && size.height > 60 && size.height < 200, `${r.out}\n${JSON.stringify(size)}`);
  r = await run(['inspect', 'Place order', '--json', '--css', 'gap,order']);
  const data = JSON.parse(r.out || '{}');
  check('--json: as data, with listeners and rules', data.selector === '#order' && data.listeners?.some((l: { type: string; where?: string }) => l.type === 'click' && l.where?.endsWith('/app.js:2')) &&
    data.rules?.[0]?.selector === '.btn.primary' && data.extra?.[1]?.[0] === 'order', r.out.slice(0, 400));
  r = await run(['inspect']);
  check('inspect with no element is a usage error', r.status === 2 && r.out.includes('usage: inspect <ref or name>'), r.out.slice(0, 200));
  r = await run(['inspect', 'button Nope']);
  check('an element that is not there says so', r.status === 1 && r.out.includes('nothing on the page is called "button Nope"'), r.out);

  const mcp = spawn(process.execPath, [cli, '--session', NAME, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
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
  await call(1, 'initialize', {});
  let reply = await call(2, 'tools/call', { name: 'browser_inspect', arguments: { ref: 'button Save for later', screenshot: true, css: ['cursor'] } });
  const content = reply.result?.content ?? [];
  const image = content.find((c: { type: string }) => c.type === 'image');
  check('over MCP: the report as text, and the picture as an image',
    !reply.result?.isError && content[0]?.text?.includes("no: it's disabled") && content[0]?.text?.includes('cursor: not-allowed') && image?.mimeType === 'image/png' && !!pngSize(Buffer.from(image.data, 'base64')), JSON.stringify(content).slice(0, 500));
  reply = await call(3, 'tools/call', { name: 'browser_inspect', arguments: { ref: 'button Place order' } });
  check('over MCP without a picture: only the text', reply.result?.content?.length === 1 && reply.result.content[0].text.includes('app.css:9'), JSON.stringify(reply.result).slice(0, 300));
  mcp.kill();
} finally {
  await run(['stop']);
  rmSync(dir, { recursive: true, force: true });
  server.stop(true);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
