// Compares ways of drawing pictures in a terminal, side by side, in the
// terminal it runs in:
//
//   1  half blocks ▀     what medley's advanced grid drew at first
//   2  quadrant blocks   OpenTUI's fallback, which it draws now where the
//                        terminal draws no pixels
//   3  Sixel             pixels, drawn by the terminal (256 colors)
//   4  Kitty graphics    pixels, drawn by the terminal (full color)
//
// Advanced grid now draws with the best of 4, 3 and 2 that the terminal has.
//
//   bun scripts/image-compare.ts [url] [--pictures 6] [--check out.html]
//
// It shows a test card first (gradients, fine text, thin lines, color), then,
// given a url, that page's window as it looks and its biggest pictures. Sixel
// and Kitty are drawn by the terminal, so how they look depends on it; the
// header says what the terminal reported supporting and what OpenTUI would
// pick by itself. A technique the terminal didn't report isn't drawn unless
// asked (f), since an unsupported one can leave garbage on the screen.
//
// --check draws each picture's comparison into an HTML file instead, with a
// stand-in terminal that supports neither Sixel nor Kitty: a look at the
// layout and the two kinds of blocks without a terminal.

import {
  createCliRenderer,
  NativeImage,
  Renderable,
  resolveImageRenderProtocol,
  RGBA,
  TextAttributes,
  type CliRenderer,
  type KeyEvent,
  type OptimizedBuffer,
  type RawImage,
} from '@opentui/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toUrl } from '../src/commands.ts';
import { Session } from '../src/session.ts';
import type { Rect } from '../src/render.ts';
import { FRAME_CSS, frameHtml } from '../test/frame-html.ts';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const pictureCount = Number(option('--pictures', '6'));
const check = option('--check', '');
const [url] = args;

// ---- the pictures -------------------------------------------------------------

interface Source {
  name: string;
  image: NativeImage;
  raw: RawImage; // its pixels, for the half blocks
}

function source(name: string, base64: string, crop?: [number, number, number, number]): Source {
  let image = NativeImage.decode(Buffer.from(base64, 'base64'));
  if (crop) {
    const [left, top] = crop;
    const width = Math.min(crop[2], image.width - left);
    const height = Math.min(crop[3], image.height - top);
    const part = image.extract({ left, top, width, height });
    image.dispose();
    image = part;
  }
  return { name, image, raw: image.raw('rgba8') };
}

/**
 * The test card, then the page's window as it looks and its biggest pictures,
 * all as the browser drew them, at full size. The pictures are taken with
 * everything else on the page hidden, as the advanced grid takes them, so a
 * banner or dialog over one doesn't end up in it.
 */
async function gather(): Promise<Source[]> {
  const session = await Session.start();
  const sources: Source[] = [];
  try {
    await session.goto('compare', pathToFileURL(join(import.meta.dir, 'image-card.html')).href);
    sources.push(source('test card: gradients, fine text, thin lines, color', (await session.screenshot()).png, [0, 0, 1280, 720]));
    if (url) {
      await session.goto('compare', toUrl(url));
      const page = session.view('compare').page!;
      const title = page.title || page.url;
      sources.push(source(`${title}: the window, as it looks`, (await session.screenshot()).png));
      const pics = await session.pictures({ scale: 1, png: true });
      // The biggest pictures that were drawn (not off to the side or below the capture), one of each place.
      const seen = new Set<string>();
      const picked = page.visual.images
        .filter((im) => im.r[2] >= 64 && im.r[3] >= 64 && im.r[0] >= 0 && im.r[0] + im.r[2] <= pics.width && im.r[1] + im.r[3] <= pics.height)
        .filter((im) => !seen.has(im.r.join()) && seen.add(im.r.join()))
        .sort((a, b) => b.r[2] * b.r[3] - a.r[2] * a.r[3])
        .slice(0, pictureCount);
      picked.forEach((im, i) => {
        const [x, y, w, h] = im.r.map(Math.round);
        sources.push(source(`${title}: picture ${i + 1}${im.alt ? ` "${im.alt.slice(0, 60)}"` : ''} (${w}×${h})`, pics.image, [x, y, w, h]));
      });
    }
  } finally {
    await session.close();
  }
  return sources;
}

// ---- half blocks, as advanced grid first drew pictures -----------------------------

const PLACEHOLDER = RGBA.fromHex('#d5d9df');

/** A screenshot's pixels: RGBA rows, `scale` pixels per page pixel. */
interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
  stride: number;
  scale: number;
}

/**
 * Average a screenshot over each half-cell of a page box drawn `cols` × `rows`
 * cells: an upper and a lower color per cell, for drawing it with ▀. Spots
 * where `covered` is true are filled from the colors around them.
 */
function halfBlocks(px: Pixels, r: Rect, cols: number, rows: number, covered: (x: number, y: number) => boolean = () => false): RGBA[] {
  // halves[h][c]: the color of half-row h, column c, or null where another picture lies.
  const halves = rows * 2;
  const grid: ([number, number, number] | null)[][] = [];
  for (let h = 0; h < halves; h++) {
    const line: ([number, number, number] | null)[] = [];
    const top = r[1] + (h * r[3]) / halves;
    const bottom = r[1] + ((h + 1) * r[3]) / halves;
    for (let c = 0; c < cols; c++) {
      const left = r[0] + (c * r[2]) / cols;
      const right = r[0] + ((c + 1) * r[2]) / cols;
      if (covered((left + right) / 2, (top + bottom) / 2)) {
        line.push(null);
        continue;
      }
      const x0 = Math.floor(left * px.scale);
      const x1 = Math.max(x0 + 1, Math.floor(right * px.scale));
      const y0 = Math.floor(top * px.scale);
      const y1 = Math.max(y0 + 1, Math.floor(bottom * px.scale));
      let red = 0;
      let green = 0;
      let blue = 0;
      let n = 0;
      // At most 4×4 samples per half-cell keeps big pictures cheap.
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let y = y0; y < y1; y += stepY) {
        if (y < 0 || y >= px.height) continue;
        for (let x = x0; x < x1; x += stepX) {
          if (x < 0 || x >= px.width) continue;
          const i = y * px.stride + x * 4;
          red += px.data[i];
          green += px.data[i + 1];
          blue += px.data[i + 2];
          n++;
        }
      }
      line.push(n ? [red / n, green / n, blue / n] : null);
    }
    grid.push(line);
  }

  // Fill each gap from the known color above it in its column (a background's
  // gradient carries on), or else below it. The color is taken a few
  // half-rows away from the gap, since right at its edge is the covering
  // picture's shadow, which would streak down the whole gap.
  const fill = (order: number[], c: number) => {
    const seen: [number, number, number][] = [];
    for (const h of order) {
      const k = grid[h][c];
      if (k) seen.push(k);
      else if (seen.length) grid[h][c] = seen[Math.max(0, seen.length - 3)];
    }
  };
  const down = Array.from({ length: halves }, (_, h) => h);
  for (let c = 0; c < cols; c++) {
    fill(down, c);
    fill([...down].reverse(), c);
  }
  const out: RGBA[] = [];
  for (let row = 0; row < rows; row++) {
    for (let c = 0; c < cols; c++) {
      for (const h of [row * 2, row * 2 + 1]) {
        const k = grid[h][c];
        out.push(k ? RGBA.fromInts(Math.round(k[0]), Math.round(k[1]), Math.round(k[2]), 255) : PLACEHOLDER);
      }
    }
  }
  return out;
}

// ---- the comparison -----------------------------------------------------------

type Kind = 'half' | 'blocks' | 'sixel' | 'kitty';
const TECHNIQUES: { kind: Kind; name: string; what: string }[] = [
  { kind: 'half', name: 'half blocks ▀', what: 'what medley drew at first · 1×2 pixels a cell' },
  { kind: 'blocks', name: 'quadrant blocks', what: 'the fallback · 2×2 pixels a cell, 2 colors' },
  { kind: 'sixel', name: 'Sixel', what: 'the terminal draws pixels · 256 colors' },
  { kind: 'kitty', name: 'Kitty graphics', what: 'the terminal draws pixels · full color' },
];
const SIZES = [1, 0.75, 0.5, 0.35, 0.25];
const SCROLL_FRAMES = 90;

const BACKGROUND = RGBA.fromHex('#202124');
const PANEL = RGBA.fromHex('#2b2d31');
const TEXT = RGBA.fromHex('#e8e8e8');
const DIM = RGBA.fromHex('#9aa0a6');
const GOOD = RGBA.fromHex('#7fd8a6');
const WARN = RGBA.fromHex('#f2c46d');
const KEY = RGBA.fromHex('#8ab4f8');

class Compare extends Renderable {
  index = 0; // which source
  zoom = 0; // 0: all four; 1-4: that one alone
  size = 0; // index into SIZES
  force = false; // draw techniques the terminal didn't report too
  scroll = -1; // frame of the scroll test, -1 when not running
  private scrollTimes: number[] = [];
  frameStart = 0; // when the frame being drawn started
  lastFrame = -1; // how long the last frame took, from drawing to written out (ms)
  note = '';
  private halves = new Map<string, RGBA[]>(); // half-block colors, by source and size

  constructor(
    private renderer: CliRenderer,
    private sources: Source[],
  ) {
    super(renderer, { width: '100%', height: '100%' });
  }

  /** The terminal's size in pixels, when it said (Sixel needs it). */
  private get resolution() {
    const r = this.renderer.resolution;
    return r && r.width > 0 && r.height > 0 && this.renderer.terminalWidth > 0 ? r : null;
  }

  /** How many times taller than wide a cell is. */
  private get cellAspect(): number {
    const r = this.resolution;
    if (!r) return 2;
    const w = r.width / this.renderer.terminalWidth;
    const h = r.height / this.renderer.terminalHeight;
    return w > 0 && h > 0 ? h / w : 2;
  }

  /** Whether the terminal reported it can draw this, and if not, why. */
  private support(kind: Kind): { ok: boolean; says: string } {
    const caps = this.renderer.capabilities;
    if (kind === 'half' || kind === 'blocks') return { ok: true, says: 'works in any terminal with 24-bit color' };
    if (!caps) return { ok: false, says: 'waiting for the terminal to say what it supports…' };
    if (kind === 'kitty') {
      return caps.kitty_graphics
        ? { ok: true, says: 'the terminal reported Kitty graphics' }
        : { ok: false, says: "the terminal didn't report Kitty graphics" };
    }
    if (!caps.sixel) return { ok: false, says: "the terminal didn't report Sixel" };
    return this.resolution
      ? { ok: true, says: 'the terminal reported Sixel and its pixel size' }
      : { ok: false, says: "the terminal reported Sixel but not its pixel size, so OpenTUI would draw blocks" };
  }

  protected renderSelf(buffer: OptimizedBuffer) {
    const { width, height } = this;
    this.frameStart = performance.now();
    const x0 = this.screenX;
    const y0 = this.screenY;
    buffer.fillRect(x0, y0, width, height, BACKGROUND);
    const src = this.sources[this.index];

    // Header: the picture, and what the terminal is and reported.
    const caps = this.renderer.capabilities;
    const res = this.resolution;
    const term = caps?.terminal?.name ? `${caps.terminal.name}${caps.terminal.version ? ` ${caps.terminal.version}` : ''}` : 'unknown terminal';
    const auto = caps ? resolveImageRenderProtocol('auto', caps, !!res) : '…';
    const envProtocol = process.env.OPENTUI_IMAGE_PROTOCOL ? ` · OPENTUI_IMAGE_PROTOCOL=${process.env.OPENTUI_IMAGE_PROTOCOL}` : '';
    this.text(buffer, x0 + 1, y0, `${this.index + 1}/${this.sources.length}  ${src.name}  (${src.image.width}×${src.image.height} px)`, TEXT, TextAttributes.BOLD, width - 2);
    const pixels = res ? `${res.width}×${res.height} px, cells ${(res.width / this.renderer.terminalWidth).toFixed(1)}×${(res.height / this.renderer.terminalHeight).toFixed(1)} px` : 'pixel size not reported';
    this.text(
      buffer, x0 + 1, y0 + 1,
      `${term} · Kitty ${caps ? (caps.kitty_graphics ? 'yes' : 'no') : '?'} · Sixel ${caps ? (caps.sixel ? 'yes' : 'no') : '?'} · ${pixels} · auto would use ${auto}${caps?.multiplexer && caps.multiplexer !== 'none' ? ` · inside ${caps.multiplexer}` : ''}${envProtocol}`,
      DIM, 0, width - 2,
    );

    // Footer: keys, and what the last frame cost.
    const cost = this.lastFrame >= 0 ? `last frame ${this.lastFrame.toFixed(1)} ms` : '';
    const keys = '← → picture · 1-4 one alone, 0 all · + − size · s scroll test · f force · q quit';
    this.text(buffer, x0 + 1, y0 + height - 1, `${keys}  ${this.note || cost}`, KEY, 0, width - 2);

    // The panels: all four in a 2×2 grid, or one alone.
    const top = y0 + 3;
    const areaH = height - 5;
    const shown = this.zoom ? [this.zoom - 1] : [0, 1, 2, 3];
    const cols = this.zoom ? 1 : 2;
    const panelW = Math.floor((width - 1) / cols);
    const panelH = this.zoom ? areaH : Math.floor(areaH / 2);
    shown.forEach((t, i) => {
      const px = x0 + 1 + (i % cols) * panelW;
      const py = top + Math.floor(i / cols) * panelH;
      this.panel(buffer, TECHNIQUES[t], src, px, py, panelW - 1, panelH - 1);
    });
  }

  private panel(buffer: OptimizedBuffer, t: (typeof TECHNIQUES)[number], src: Source, x: number, y: number, w: number, h: number) {
    buffer.fillRect(x, y, w, h, PANEL);
    const support = this.support(t.kind);
    const n = TECHNIQUES.indexOf(t) + 1;
    this.text(buffer, x + 1, y, `${n} ${t.name}`, TEXT, TextAttributes.BOLD, w - 2);
    this.text(buffer, x + 4 + t.name.length, y, `· ${t.what}`, DIM, 0, w - 5 - t.name.length);
    this.text(buffer, x + 1, y + 1, support.says, support.ok ? GOOD : WARN, 0, w - 2);

    // Room for the picture, less 2 rows above and below for the scroll test to move it.
    const areaW = w - 2;
    const areaH = h - 3 - 4;
    if (areaW < 8 || areaH < 4) return this.text(buffer, x + 1, y + 3, 'make the window bigger', WARN, 0, w - 2);
    if (!support.ok && !this.force) {
      return this.text(buffer, x + 1, y + 3 + Math.floor(areaH / 2), 'not drawn · f tries it anyway', DIM, 0, w - 2);
    }
    // Fit the picture, keeping its shape in this terminal's cells, then shrink to the chosen size.
    const scale = SIZES[this.size];
    const shape = (src.image.width / src.image.height) * this.cellAspect; // columns per row
    let cellsW = Math.min(areaW, Math.round(areaH * shape));
    let cellsH = Math.round(cellsW / shape);
    cellsW = Math.max(2, Math.round(cellsW * scale));
    cellsH = Math.max(1, Math.round(cellsH * scale));
    const dy = this.scroll >= 0 ? Math.round(2 * Math.sin((this.scroll / SCROLL_FRAMES) * Math.PI * 6)) : 0;
    const ix = x + 1 + Math.floor((areaW - cellsW) / 2);
    const iy = y + 3 + 2 + Math.floor((areaH - cellsH) / 2) + dy;

    if (t.kind === 'half') {
      const key = `${this.index}:${cellsW}x${cellsH}`;
      let cells = this.halves.get(key);
      if (!cells) {
        const raw = src.raw;
        const px = { data: raw.data, width: raw.width, height: raw.height, stride: raw.stride, scale: 1 };
        cells = halfBlocks(px, [0, 0, raw.width, raw.height], cellsW, cellsH);
        this.halves.set(key, cells);
      }
      for (let row = 0; row < cellsH; row++) {
        for (let c = 0; c < cellsW; c++) {
          const k = (row * cellsW + c) * 2;
          buffer.drawText('▀', ix + c, iy + row, cells[k], cells[k + 1]);
        }
      }
      return;
    }
    const res = this.resolution;
    const pw = res ? Math.max(1, Math.round((cellsW * res.width) / this.renderer.terminalWidth)) : 0;
    const ph = res ? Math.max(1, Math.round((cellsH * res.height) / this.renderer.terminalHeight)) : 0;
    const drawn = buffer.drawImage(src.image, ix, iy, cellsW, cellsH, pw, ph, 0, 0, src.image.width, src.image.height, t.kind);
    if (!drawn) this.text(buffer, x + 1, y + 2, 'OpenTUI declined to draw it', WARN, 0, w - 2);
  }

  private text(buffer: OptimizedBuffer, x: number, y: number, s: string, fg: RGBA, attrs = 0, max = Infinity) {
    if (max <= 0) return;
    buffer.drawText(s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s, x, y, fg, undefined, attrs);
  }

  /** Move the pictures up and down for a moment, as scrolling the grid would, and time the frames. */
  scrollTest() {
    if (this.scroll >= 0) return;
    this.scroll = 0;
    this.scrollTimes = [];
    const timer = setInterval(() => {
      if (this.scroll > 0) this.scrollTimes.push(this.lastFrame);
      this.scroll++;
      if (this.scroll >= SCROLL_FRAMES) {
        clearInterval(timer);
        this.scroll = -1;
        const times = this.scrollTimes.filter((t) => t >= 0);
        const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
        this.note = `scroll test: ${times.length} frames, average ${avg.toFixed(1)} ms, slowest ${Math.max(...times).toFixed(1)} ms`;
      }
      this.requestRender();
    }, 33);
  }
}

// ---- running it -------------------------------------------------------------------

console.log(`medley image compare: taking the pictures${url ? ` (test card, ${url})` : ' (test card)'}…`);
const sources = await gather();

if (check) {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 160, height: 48 });
  const view = new Compare(setup.renderer, sources);
  view.force = true; // the image calls run too, though this stand-in draws nothing for them
  setup.renderer.root.add(view);
  const frames: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    view.index = i;
    await setup.renderOnce();
    frames.push(`<pre>${frameHtml(setup.captureSpans())}</pre>`);
  }
  writeFileSync(
    check,
    `<!doctype html><meta charset="utf-8"><title>medley image compare</title>
<style>body{margin:0;background:#1e1e1e;color:#ddd}pre{margin:0 0 12px;font:13px/1.15 Consolas,Menlo,monospace}${FRAME_CSS}</style>
${frames.join('\n')}`,
  );
  console.log(`${sources.length} pictures → ${check}`);
  setup.renderer.destroy();
  for (const s of sources) s.image.dispose();
  process.exit(0);
}

const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30, useMouse: false });
const view = new Compare(renderer, sources);
renderer.root.add(view);

// A frame's time runs from drawing it to OpenTUI having written it out.
renderer.on('frame', () => {
  view.lastFrame = performance.now() - view.frameStart;
});
// The terminal answers what it supports and its pixel size a moment after start.
renderer.on('capabilities', () => view.requestRender());
renderer.on('resize', () => view.requestRender());
for (const ms of [250, 1000, 2500]) setTimeout(() => view.requestRender(), ms);

renderer.keyInput.on('keypress', (key: KeyEvent) => {
  view.note = '';
  const name = key.name;
  if (name === 'q' || (name === 'escape' && !view.zoom)) return quit();
  if (name === 'right' || name === 'n' || name === 'space') view.index = (view.index + 1) % sources.length;
  else if (name === 'left' || name === 'p') view.index = (view.index - 1 + sources.length) % sources.length;
  else if (/^[1-4]$/.test(name)) view.zoom = Number(name);
  else if (name === '0' || name === 'escape') view.zoom = 0;
  else if (name === '-' || name === 'minus') view.size = Math.min(SIZES.length - 1, view.size + 1);
  else if (name === '+' || name === '=' || name === 'plus' || name === 'equal') view.size = Math.max(0, view.size - 1);
  else if (name === 's') view.scrollTest();
  else if (name === 'f') {
    view.force = !view.force;
    view.note = view.force ? 'drawing every technique, reported or not' : 'drawing only what the terminal reported';
  }
  view.requestRender();
});

function quit() {
  renderer.destroy();
  for (const s of sources) s.image.dispose();
  process.exit(0);
}
