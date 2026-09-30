// Cross-origin frames, end to end: a page on 127.0.0.1 embeds a sign-in form
// from localhost (another site, so it runs in its own process), which embeds
// a widget from 127.0.0.1 again. Medley should read all three as one page and
// act inside each.
//
//   bun test/frames.ts

import { Session } from '../src/session.ts';

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname;
    const page = PAGES[path];
    return page ? new Response(page(server.port!), { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 });
  },
});

const PAGES: Record<string, (port: number) => string> = {
  '/': (port) => `<!doctype html><title>Frames test</title>
<h1>Shop</h1>
<p><a href="#top">Home</a> <button id="p" onclick="pout.textContent = 'Parent clicked'">Parent button</button> <span id="pout">Parent not clicked</span></p>
<div style="height: 1400px">Tall content, so the frame starts below the fold.</div>
<iframe title="Sign in" src="http://localhost:${port}/child" width="640" height="460" style="border: 3px solid #333; padding: 6px"></iframe>
<p><a href="#after">After the frame</a></p>`,
  '/child': (port) => `<!doctype html><title>Sign in</title>
<h2>Sign in</h2>
<form onsubmit="return false">
  <p><label>Email <input id="email"></label></p>
  <p><label><input type="checkbox" id="remember"> Remember me</label></p>
  <p><label>Plan <select id="plan"><option>Free</option><option>Pro</option></select></label></p>
  <p><button type="button" id="go">Sign in</button></p>
</form>
<p id="out">Not signed in</p>
<iframe title="Likes" src="http://127.0.0.1:${port}/grandchild" width="320" height="90"></iframe>
<div style="height: 600px"></div>
<p><a href="#end" id="end">End of the form frame</a></p>
<script>
  go.onclick = () => { out.textContent = 'Signed in as ' + email.value + (remember.checked ? ' (remembered)' : '') + ' on ' + plan.value; };
</script>`,
  '/grandchild': () => `<!doctype html><title>Likes</title>
<button id="like">Like</button> <span id="likes">0 likes</span>
<script>let n = 0; like.onclick = () => { likes.textContent = ++n + ' likes'; };</script>`,

  // A frame that loads another page, whose elements get the same numbers there.
  '/stale': (port) => `<!doctype html><title>Stale</title><h1>Stale refs</h1>
<iframe title="Steps" src="http://localhost:${port}/stale-a" width="500" height="120"></iframe>`,
  '/stale-a': (port) => `<!doctype html><a href="http://localhost:${port}/stale-b">Next</a> <button onclick="out.textContent = 'Original clicked'">Original action</button> <span id="out"></span>`,
  '/stale-b': (port) => `<!doctype html><a href="http://localhost:${port}/stale-a">Back</a> <button onclick="out.textContent = 'Unrelated clicked'">Unrelated action</button> <span id="out"></span>`,

  // A notice over the page, covering frames from another site and from this one.
  '/cover': (port) => `<!doctype html><title>Covered</title><h1>Covered frames</h1>
<iframe title="Other site" src="http://localhost:${port}/cover-child" width="400" height="80"></iframe>
<iframe title="This site" src="/cover-child" width="400" height="80"></iframe>
<div style="position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); color: white">A notice over everything</div>`,
  '/cover-child': () => `<!doctype html><button onclick="out.textContent = 'Covered button clicked'">Covered button</button> <span id="out"></span>`,

  // A frame from this site, read in like any other; and a table with hidden rows and cells.
  '/same': () => `<!doctype html><title>Same site</title><h1>Same-site frame</h1>
<iframe title="Same" src="/same-child" width="400" height="100"></iframe>
<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Shown row</td><td>1</td></tr>
<tbody hidden><tr><td>Hidden body row</td><td>2</td></tr></tbody>
<tr style="visibility: collapse"><td>Collapsed row</td><td>3</td></tr>
<tr><td>Another row</td><td style="visibility: hidden">Hidden cell</td></tr></table>`,
  '/same-child': () => `<!doctype html><h2>Inside the frame</h2><button onclick="out.textContent = 'Inside clicked'">Inside button</button> <span id="out">Not clicked</span>`,
};

let failures = 0;
function check(what: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `\n${detail}`}`);
  if (!ok) failures++;
}
const refOf = (text: string, pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? NaN);

const session = await Session.start();
try {
  const page = await session.goto('t', `http://127.0.0.1:${server.port}/`);
  console.log(page, '\n');
  check('the page keeps its own refs', /\[1\]Home/.test(page) && /\[2 button "Parent button"\]/.test(page));
  check('the frame is read in, under a divider', page.includes('── iframe "Sign in" ──') && page.includes('## Sign in'), page);
  check('the frame inside the frame is read in too', page.includes('── iframe "Likes" ──') && page.includes('0 likes'), page);

  const email = refOf(page, /\[(\d+) textbox "Email"\]/);
  const remember = refOf(page, /\[(\d+) checkbox "Remember me"/);
  const plan = refOf(page, /\[(\d+) select "Plan"/);
  const go = refOf(page, /\[(\d+) button "Sign in"\]/);
  const like = refOf(page, /\[(\d+) button "Like"\]/);
  const end = refOf(page, /\[(\d+)\]End of the form frame/);
  check('refs in frames are numbered page-wide', [email, remember, plan, go, like, end].every((n) => n > 3) && new Set([email, go, like]).size === 3);

  let r = await session.type('t', email, 'ada@example.com');
  console.log(r, '\n');
  check('type into a field in the frame', r.includes('= "ada@example.com"'), r);
  r = await session.click('t', remember);
  check('click a checkbox in the frame (below the fold)', r.includes('checkbox "Remember me" checked'), r);
  r = await session.select('t', plan, 'Pro');
  check('select in the frame', r.includes('selected "Pro"'), r);
  r = await session.click('t', go);
  console.log(r, '\n');
  check('click a button in the frame', r.includes('Signed in as ada@example.com (remembered) on Pro'), r);
  r = await session.click('t', like);
  check('click a button in the frame inside the frame', r.includes('1 likes'), r);
  r = await session.click('t', 2);
  check("the page's own refs still work", r.includes('Parent clicked'), r);
  r = await session.scroll('t', String(end));
  check('scroll to a ref deep in the frame', !r.startsWith('scroll') || r.includes('scrolled to'), r);
  r = await session.click('t', end);
  check('click a link at the bottom of the frame', r.startsWith('clicked'), r);
  r = await session.snapshot('t', { diff: true });
  check('refs stay put across snapshots', r.includes('no visible change') || !r.includes('new page'), r);

  // A ref from before its frame loaded another page is refused, not taken to
  // mean the element that has its number now, even after another client looks.
  const stale = await session.goto('t', `http://127.0.0.1:${server.port}/stale`);
  const original = refOf(stale, /\[(\d+) button "Original action"\]/);
  const next = refOf(stale, /\[(\d+)\]Next/);
  await session.snapshot('other');
  r = await session.click('other', next);
  check('another client moves the frame on', r.includes('Unrelated action'), r);
  r = await session.click('t', original).catch((e: Error) => `error: ${e.message}`);
  check("a stale frame ref is refused", r.startsWith('error:') && r.includes('loaded another page'), r);
  r = await session.snapshot('t');
  check('and nothing was clicked', !r.includes('Unrelated clicked') && !r.includes('Original clicked'), r);

  // A notice over the page covers the frames under it: the click fails, saying so.
  const covered = await session.goto('t', `http://127.0.0.1:${server.port}/cover`);
  const [other, same] = [...covered.matchAll(/\[(\d+) button "Covered button"\]/g)].map((m) => Number(m[1]));
  for (const [which, ref] of [['from another site', other], ['from this site', same]] as const) {
    r = await session.click('t', ref).catch((e: Error) => `error: ${e.message}`);
    check(`a frame ${which} under a notice: covered, not clicked`, r.startsWith('error:') && r.includes('covered by') && r.includes('A notice over everything'), r);
  }
  r = await session.snapshot('t');
  check('and neither button was clicked', !r.includes('Covered button clicked'), r);

  // A frame from this site reads in like one from another; hidden rows and cells don't show.
  const same2 = await session.goto('t', `http://127.0.0.1:${server.port}/same`);
  check('a frame from this site is read in, under a divider', same2.includes('── iframe "Same" ──') && same2.includes('## Inside the frame'), same2);
  r = await session.click('t', refOf(same2, /\[(\d+) button "Inside button"\]/));
  check('and its buttons work', r.includes('Inside clicked'), r);
  check("a table's hidden rows and cells don't show", same2.includes('Shown row') && same2.includes('Another row') &&
    !same2.includes('Hidden body row') && !same2.includes('Collapsed row') && !same2.includes('Hidden cell'), same2);
} catch (e) {
  check('no errors', false, String((e as Error).stack ?? e));
} finally {
  await session.close();
  server.stop(true);
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
