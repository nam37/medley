// Drives the terminal UI through OpenTUI's test renderer on the demo shop and
// saves frames along the way as HTML fragments (colored terminal cells), for
// the website and its video.
//
//   bun scripts/site-shots.ts <out-dir> [--width 120] [--rows 34] [--as <url>]
//
// Writes <name>.html for each frame (the inside of a <pre>) and all.html,
// which shows them all. --as shows the page's address as <url> in the top
// bar, such as where the demo is published, instead of its local file.

import { createTestRenderer } from '@opentui/core/testing';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { send } from '../src/client.ts';
import { App } from '../src/tui/app.ts';
import { sessionBackend } from '../src/tui/main.ts';
import { frameHtml } from '../test/frame-html.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const width = Number(option('--width', '120'));
const rows = Number(option('--rows', '34'));
const shownUrl = option('--as', '');
const [out] = args;
if (!out) {
  console.error('usage: bun scripts/site-shots.ts <out-dir> [--width 120] [--rows 34] [--as <url>]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const SESSION = 'site-shots';
const AGENT = 'mcp-site-shots';
const url = pathToFileURL(join(import.meta.dir, '..', 'docs', 'demo', 'index.html')).href;
const setup = await createTestRenderer({ width, height: rows });
const { mockInput } = setup;
const app = new App(setup.renderer, sessionBackend(SESSION, {}));
const saved: string[] = [];

async function until(what: string, test: (frame: string) => boolean, ms = 20000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (test(frame)) return frame;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}:\n${setup.captureCharFrame()}`);
}

async function save(name: string) {
  await setup.renderOnce();
  let html = frameHtml(setup.captureSpans());
  // Pad to the same length so the rest of the top bar stays where it was.
  if (shownUrl) html = html.replaceAll(url, shownUrl.padEnd(url.length));
  writeFileSync(join(out, `${name}.html`), html);
  saved.push(name);
  console.log(`${name}.html`);
}

const keys = async (...names: string[]) => {
  for (const k of names) mockInput.pressKey(k);
  await setup.renderOnce();
};

try {
  void app.start(url);
  await until('the page', (f) => f.includes('Pack light'));
  await save('none');

  await keys('v');
  await until('partial grid', (f) => f.includes('partial grid'));
  await save('partial');

  await keys('v');
  await until('the pictures', (f) => f.includes('advanced grid') && f.includes('▀'));
  await save('advanced');

  await keys('v');
  await until('no grid', (f) => f.includes('no grid'));

  // The agent and the person drive the same session.
  mockInput.pressKey('/');
  await mockInput.typeText('Trail notes');
  mockInput.pressEnter();
  await until('the form', (f) => f.includes('textbox "Email"'));
  mockInput.pressEscape();
  await Bun.sleep(100); // a lone Esc waits briefly in case it starts an escape sequence
  await until('the find to clear', (f) => !f.includes('match'));

  await send(SESSION, { cmd: 'snapshot', client: AGENT });
  await send(SESSION, { cmd: 'type', args: { ref: 12, text: 'sam@example.com' }, client: AGENT });
  await until('the agent', (f) => f.includes('agent:') && f.includes('sam@example.com'));
  await save('agent-typed');

  void send(SESSION, { cmd: 'click', args: { ref: 14 }, client: AGENT });
  await until('the dialog', (f) => f.includes('the page asks (confirm)'));
  await save('confirm');

  await keys('y');
  await until('the answer', (f) => f.includes('Thanks!'));
  await save('accepted');
} finally {
  setup.renderer.destroy();
  await send(SESSION, { cmd: 'stop', client: 'site-shots' }).catch(() => {});
}

writeFileSync(
  join(out, 'all.html'),
  `<!doctype html><meta charset="utf-8"><title>medley frames</title>
<style>body{margin:24px;background:#111;color:#ddd;font:14px system-ui}pre{margin:6px 0 28px;background:#1e1e1e;color:#ddd;font:13px/1.15 Consolas,Menlo,monospace;display:inline-block}</style>
${saved.map((name) => `<div>${name}</div><pre>${readFileSync(join(out, `${name}.html`), 'utf8')}</pre>`).join('\n')}`,
);
process.exit(0);
