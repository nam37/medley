// The logo, shown centered while there's no page yet: medley's pixel "m" (a
// 5×4 grid of blocks, drawn with half-block characters so the blocks come out
// square) with a light running along the letter's strokes, the name under it,
// and what medley is doing.

import { Renderable, RGBA, TextAttributes, type OptimizedBuffer, type RenderContext, type RenderableOptions } from '@opentui/core';
import { THEME } from './theme.ts';

// The blocks of the "m", as [column, row] (1-based), in the order a pen would
// draw it: up the left leg, across, down the middle, across, down the right.
const STROKE: [number, number][] = [
  [1, 4], [1, 3], [1, 2], [1, 1], [2, 1], [3, 2], [3, 3], [3, 4], [4, 1], [5, 1], [5, 2], [5, 3], [5, 4],
];
const DARK: [number, number] = [5, 1]; // the logo's one dark block

const BLOCK = 4; // a block is 4 columns by 4 half-rows: square in a terminal's 1:2 cells
const GAP = 1;
const WIDTH = 5 * BLOCK + 4 * GAP;
const HALF_ROWS = 4 * BLOCK + 3 * GAP;
const FRAME_MS = 70;
const TRAIL = 4; // blocks lit behind the head of the light

// The brand green, from its resting shade up to the head of the light; and the dark block's.
const GREEN = ['#0a7d5e', '#15966f', '#2bb487', '#5fd3a8', '#a8f0d2'].map((h) => RGBA.fromHex(h));
const SLATE = ['#3a4855', '#4b5a68', '#617282', '#7d8f9f', '#a3b4c3'].map((h) => RGBA.fromHex(h));

export class Splash extends Renderable {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private note = '';

  constructor(ctx: RenderContext, options: RenderableOptions<Splash>) {
    super(ctx, options);
  }

  /** Show the logo (and run the light) or hide it. */
  show(on: boolean) {
    this.visible = on;
    if (on && !this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        this.requestRender();
      }, FRAME_MS);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** A line under the name: what's happening ("opening en.wikipedia.org…"). */
  setNote(note: string) {
    if (note === this.note) return;
    this.note = note;
    this.requestRender();
  }

  stop() {
    this.show(false);
  }

  /** How bright a block is (0: resting, up to 4: the head of the light). */
  private level(index: number): number {
    const head = this.frame % (STROKE.length + TRAIL * 2); // a pause between laps
    const behind = head - index;
    return behind >= 0 && behind <= TRAIL ? TRAIL - behind : 0;
  }

  protected renderSelf(buffer: OptimizedBuffer) {
    const { screenX, screenY, width, height } = this;
    // The logo, then a blank row, the name, and the note: centered as a group.
    const rows = HALF_ROWS / 2 + 4;
    if (width < WIDTH + 2 || height < rows) return;
    const x0 = screenX + Math.floor((width - WIDTH) / 2);
    const y0 = screenY + Math.max(0, Math.floor((height - rows) / 2));

    // Which color each half-row pixel is (or none).
    const colorAt = new Map<string, RGBA>();
    STROKE.forEach(([c, r], i) => {
      const palette = c === DARK[0] && r === DARK[1] ? SLATE : GREEN;
      const color = palette[this.level(i)];
      const left = (c - 1) * (BLOCK + GAP);
      const top = (r - 1) * (BLOCK + GAP);
      for (let dx = 0; dx < BLOCK; dx++) for (let dy = 0; dy < BLOCK; dy++) colorAt.set(`${left + dx},${top + dy}`, color);
    });
    for (let row = 0; row < Math.ceil(HALF_ROWS / 2); row++) {
      for (let x = 0; x < WIDTH; x++) {
        const upper = colorAt.get(`${x},${row * 2}`);
        const lower = colorAt.get(`${x},${row * 2 + 1}`);
        if (upper && lower) buffer.drawText('▀', x0 + x, y0 + row, upper, lower, 0);
        else if (upper) buffer.drawText('▀', x0 + x, y0 + row, upper, undefined as any, 0);
        else if (lower) buffer.drawText('▄', x0 + x, y0 + row, lower, undefined as any, 0);
      }
    }
    const below = y0 + Math.ceil(HALF_ROWS / 2) + 1;
    const center = (text: string, y: number, fg: RGBA, attrs = 0) =>
      buffer.drawText(text, screenX + Math.max(0, Math.floor((width - Bun.stringWidth(text)) / 2)), y, fg, undefined as any, attrs);
    center('m e d l e y', below, THEME.text, TextAttributes.BOLD);
    center('a text-mode web browser for humans and agents', below + 1, THEME.dim);
    if (this.note) center(this.note, below + 3, THEME.dim);
  }
}
