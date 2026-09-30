// Whether medley's word can be trusted when things go wrong: typing lands in
// the field it names or fails; a page stuck in a script, or held up by a
// request that never ends, can't hang the session, and stop always works; a
// wait that couldn't look doesn't claim anything; a command whose sender gave
// up isn't run later; a replay that failed says so over MCP; and closed tabs
// leave nothing behind.
//
//   bun test/stability.ts

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// The browser has this long to answer before medley gives up: short, so stuck pages are quick to
// test. Set before medley's modules load (they read it then).
process.env.MEDLEY_PAGE_TIMEOUT = '4';
const { readSessionInfo } = await import('../src/client.ts');
const { Session } = await import('../src/session.ts');

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 255, // hold /never open for as long as a test takes
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/never') return new Promise<Response>(() => {}); // a script that never arrives
    const page = PAGES[path];
    return page ? new Response(page, { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

const PAGES: Record<string, string> = {
  '/form': `<!doctype html><title>Form</title>
<p><label>Notes <input id="notes"></label></p>
<div role="combobox" aria-label="Size" aria-expanded="false">Choose a size</div>
<div role="combobox" aria-label="Color" aria-controls="color-pop" aria-expanded="false" onclick="pop.hidden = false; search.focus()">Choose a color</div>
<div id="pop" hidden><input id="search" aria-label="Search colors"></div>
<p id="out"></p>
<script>
  const show = () => { out.textContent = 'notes: ' + notes.value + ' · search: ' + search.value; };
  notes.oninput = show;
  search.oninput = show;
</script>`,
  '/stuck': `<!doctype html><title>Stuck</title><h1>Stuck</h1><p>Loading</p>
<button onclick="setTimeout(() => { for (;;) {} }, 300)">Freeze</button>
<button onclick="this.textContent = 'Marked'">Mark</button>`,
  '/slow': `<!doctype html><title>Slow</title><h1>Slow</h1><p>Before the script</p><script src="/never"></script><p>After the script</p>`,
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
const ref = (text: string, pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? NaN);
const seconds = (t0: number) => (performance.now() - t0) / 1000;

const session = await Session.start();
try {
  // Typing goes where it says, or fails.
  let page = await session.goto('t', url('/form'));
  let r = await session.type('t', ref(page, /\[(\d+) textbox "Notes"\]/), 'first');
  check('typing into a field', r.includes('notes: first'), r);
  r = await attempt(session.type('t', ref(page, /\[(\d+) combobox "Size"/), 'M'));
  check("a combobox that can't take the keyboard: an error, not text in the field before it",
    r.startsWith('error:') && r.includes("didn't take the keyboard") && !(await session.snapshot('t')).includes('notes: firstM'), r);
  page = await session.snapshot('t');
  r = await attempt(session.type('t', ref(page, /\[(\d+) combobox "Color"/), 'red'));
  check('a combobox whose click opens a search box: typed into that', r.includes('search: red') && !r.includes('notes: firstred'), r);

  // A page stuck in a script: nothing waits on it for long, a wait that couldn't look says so, and reload frees it.
  page = await session.goto('t', url('/stuck'));
  let t0 = performance.now();
  r = await attempt(session.click('t', ref(page, /\[(\d+) button "Freeze"\]/)));
  check(`a click that leaves the page stuck returns (${seconds(t0).toFixed(1)}s)`, seconds(t0) < 20, r);
  t0 = performance.now();
  r = await attempt(session.waitFor('t', 'Loading', { gone: true, seconds: 2 }));
  check(`waiting for text to go, on a page that can't answer: not "went away" (${seconds(t0).toFixed(1)}s)`,
    r.startsWith('error:') && r.includes("couldn't tell whether") && !r.includes('went away after'), r);
  t0 = performance.now();
  r = await attempt(session.reload('t'));
  check(`reload stops the stuck script and reloads (${seconds(t0).toFixed(1)}s)`, r.includes('Loading') && r.includes('stuck') && seconds(t0) < 20, r);

  // A page held up by a script that never arrives: shown as far as it got, saying so.
  t0 = performance.now();
  r = await attempt(session.goto('t', url('/slow')));
  check(`a page still loading: back within bounds, saying so (${seconds(t0).toFixed(1)}s)`,
    seconds(t0) < 30 && r.includes('Before the script') && r.includes('still loading'), r);

  // Tabs opened and closed leave no listeners behind.
  const listeners = () => (session as any).browser.cdp.listeners.size as number;
  await session.goto('t', url('/form'));
  const before = listeners();
  for (let i = 0; i < 5; i++) {
    await session.newTab('t', url('/form'));
    await session.closeTab('t');
  }
  check(`five tabs opened and closed: listeners ${before} before, ${listeners()} after`, listeners() === before);
} catch (e) {
  check('no errors', false, String((e as Error).stack ?? e));
} finally {
  await session.close();
}

// Through a session daemon: stop answers at once, even while a command is stuck;
// a command whose sender gave up isn't run; a failed replay is an error over MCP.
const NAME = 'stability-test';
const cli = join(import.meta.dir, '..', 'src', 'medley.ts');
const env = { ...process.env, MEDLEY_PAGE_TIMEOUT: '4' };
const medley = (...args: string[]) => spawnSync(process.execPath, [cli, '--session', NAME, '--no-color', ...args], { encoding: 'utf8', env });
medley('stop');
try {
  const page = medley('goto', url('/stuck')).stdout;
  // A sender that gives up while its command waits in line: it isn't run.
  const info = readSessionInfo(NAME)!;
  const post = (cmd: string, args: object, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${info.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-medley-token': info.token },
      body: JSON.stringify({ cmd, args, client: 'test' }),
      signal,
    });
  const waiting = post('wait', { seconds: 2 });
  await Bun.sleep(200);
  await post('click', { ref: ref(page, /\[(\d+) button "Mark"\]/) }, AbortSignal.timeout(500)).catch(() => {});
  await waiting;
  const after = medley('snapshot').stdout;
  check("a command whose sender gave up in line isn't run", after.includes('button "Mark"') && !after.includes('Marked'), after);

  // stop while a command is stuck on a frozen page.
  medley('click', 'Freeze');
  const stuck = spawn(process.execPath, [cli, '--session', NAME, 'snapshot'], { stdio: 'ignore', env });
  await Bun.sleep(300);
  const t0 = performance.now();
  const stop = medley('stop');
  check(`stop answers at once while a command is stuck (${seconds(t0).toFixed(1)}s)`, seconds(t0) < 5 && stop.stdout.includes('stopped'), stop.stdout + stop.stderr);
  for (let i = 0; i < 40 && readSessionInfo(NAME); i++) await Bun.sleep(100);
  check('and the session is gone', !readSessionInfo(NAME));
  stuck.kill();

  // A replay that failed is an error over MCP, as it is on the command line.
  const mcp = spawn(process.execPath, [cli, '--session', NAME, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'], env });
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
  const replayed = await call(2, 'tools/call', { name: 'browser_replay', arguments: { script: `goto ${url('/form')}\nexpect Nothing like this` } });
  const text = replayed.result?.content?.map((c: { text: string }) => c.text).join('\n') ?? '';
  check('a failed replay over MCP is an error', replayed.result?.isError === true && text.includes('✗ 2 expect'), JSON.stringify(replayed.result));
  mcp.kill();
} finally {
  medley('stop');
  server.stop(true);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
