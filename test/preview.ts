// Renders a page the way the terminal UI draws it, into an HTML file of
// colored terminal cells, for looking at the grid modes without a terminal.
//
//   bun test/preview.ts <url> [out.html] [--mode none|partial|advanced] [--width 150] [--rows 120]

import { NativeImage } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { writeFileSync } from 'node:fs';
import { toUrl } from '../src/commands.ts';
import { frameHtml } from './frame-html.ts';
import { Session } from '../src/session.ts';
import { PageView, type GridMode } from '../src/tui/page-view.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const mode = option('--mode', 'advanced') as GridMode;
const width = Number(option('--width', '150'));
const rows = Number(option('--rows', '120'));
const [url, out = 'preview.html'] = args;
if (!url) {
  console.error('usage: bun test/preview.ts <url> [out.html] [--mode none|partial|advanced] [--width 150] [--rows 120]');
  process.exit(2);
}

const session = await Session.start();
let page;
let shot;
try {
  await session.goto('preview', toUrl(url));
  page = session.view('preview').page!;
  shot = mode === 'advanced' ? await session.pictures() : undefined;
} finally {
  await session.close();
}

const setup = await createTestRenderer({ width, height: rows });
try {
  const view = new PageView(setup.renderer, { width: '100%', height: '100%' });
  setup.renderer.root.add(view);
  view.setPage(page.body, new Map(page.labels), new Set(), true, page.layout, page.visual);
  view.gridMode = mode;
  if (shot) {
    const image = NativeImage.decode(Buffer.from(shot.jpeg, 'base64'));
    const raw = image.raw('rgba8');
    image.dispose();
    view.setPixels({ data: raw.data, width: raw.width, height: raw.height, stride: raw.stride, scale: raw.width / shot.width });
  }
  await setup.renderOnce();

  writeFileSync(
    out,
    `<!doctype html><meta charset="utf-8"><title>medley preview</title>
<style>body{margin:0;background:#1e1e1e;color:#ddd}pre{margin:0;font:13px/1.15 Consolas,Menlo,monospace}</style>
<pre>${frameHtml(setup.captureSpans())}</pre>`,
  );
  console.log(`${page.title} · ${mode} · ${width}x${rows} → ${out}`);
} finally {
  setup.renderer.destroy();
}
