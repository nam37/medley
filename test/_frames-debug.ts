import { Session } from '../src/session.ts';
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
  const p = new URL(req.url).pathname; const port = server.port;
  const html = p === '/' ? `<title>t</title><div style="height:1400px">tall</div><iframe title="Sign in" src="http://localhost:${port}/child" width="640" height="460" style="border:3px solid #333;padding:6px"></iframe>`
    : p === '/child' ? `<h2>Sign in</h2><div style="height:50px"></div><iframe title="Likes" src="http://127.0.0.1:${port}/gc" width="320" height="90"></iframe>`
    : `<button id="like" onclick="likes.textContent='liked'">Like</button> <span id="likes">0 likes</span>`;
  return new Response(html, { headers: { 'content-type': 'text/html' } }); } });
const s: any = await Session.start();
try {
  console.log(await s.goto('t', `http://127.0.0.1:${server.port}/`));
  const page = s.page;
  const t = s.target(1);
  console.log('target', t, 'chain', page.frameChain(t.frame), 'parents', page.frameChain(t.frame).map((f: string) => page.parentOf(f)));
  console.log('frames', [...page.frames].map(([id, f]: any) => [id.slice(0, 6), f.parentId?.slice(0, 6), f.session.slice(0, 6)]), 'targets', [...page.targets].map(([id, x]: any) => [id.slice(0, 6), x.slice(0, 6)]));
  for (const f of page.frameChain(t.frame)) console.log('box of', f.slice(0, 6), 'in', page.parentOf(f)?.slice(0, 6) ?? 'main', await page.evaluateIn(page.parentOf(f), '(' + require('fs').readFileSync('src/page-actions.js','utf8') + ').frameBox(' + JSON.stringify(f) + ', false)'));
  console.log('locate', await s.locate(1));
  console.log('elementFromPoint at locate (top):', await page.evaluate(`(() => { const p = ${JSON.stringify(await s.locate(1))}; const e = document.elementFromPoint(p.x, p.y); return e && e.outerHTML.slice(0, 80); })()`));
  console.log(await s.click('t', 1));
} finally { await s.close(); server.stop(true); }
process.exit(0);
