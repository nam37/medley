// One of the page's pictures as big as the view fits it: the terminal UI's i.
// Pictures come from the page's screenshot (see PageView) and are drawn the
// best way the terminal can, as in advanced grid: Kitty graphics, Sixel, or
// block characters.

import {
  Renderable,
  RGBA,
  TextAttributes,
  type MouseEvent,
  type NativeImage,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from '@opentui/core';
import type { Rect } from '../render.ts';
import { cellAspect, pixelsFor } from './page-view.ts';
import { THEME } from './theme.ts';

const BACKDROP = RGBA.fromHex('#16181c');
const CAPTION = RGBA.fromHex('#d8dadf');
const DIM = RGBA.fromHex('#8b9098');

export interface ViewedPicture {
  r: Rect; // where it is on the page, in page pixels
  alt: string;
}

type Source = { image: NativeImage; scale: number } | null;

export class PictureView extends Renderable {
  private list: ViewedPicture[] = [];
  private index = 0;
  private source: () => Source = () => null;

  constructor(ctx: RenderContext, options: RenderableOptions<PictureView>) {
    super(ctx, { ...options, visible: false });
  }

  /** Show `list[index]`, taking pictures from `source` (null until the page's screenshot arrives). */
  open(list: ViewedPicture[], index: number, source: () => Source) {
    this.list = list;
    this.index = Math.min(Math.max(0, index), list.length - 1);
    this.source = source;
    this.visible = true;
    this.requestRender();
  }

  close() {
    this.visible = false;
  }

  /** Move by `by` pictures, stopping at the first and last. */
  step(by: number) {
    this.index = Math.min(Math.max(0, this.index + by), this.list.length - 1);
    this.requestRender();
  }

  protected renderSelf(buffer: OptimizedBuffer) {
    const { width, height } = this;
    const x0 = this.screenX;
    const y0 = this.screenY;
    buffer.fillRect(x0, y0, width, height, BACKDROP);
    const pic = this.list[this.index];
    if (!pic) return;

    // The caption: which picture, what it shows, and the keys.
    const [w, h] = [Math.round(pic.r[2]), Math.round(pic.r[3])];
    const where = `${this.index + 1}/${this.list.length}`;
    const keys = '← → picture · Esc closes';
    const room = width - where.length - keys.length - 8;
    const alt = pic.alt || 'no description';
    const about = `${alt.length > room ? alt.slice(0, Math.max(0, room - 1)) + '…' : alt} · ${w}×${h}`;
    const y = y0 + height - 1;
    buffer.drawText(` ${where}`, x0, y, THEME.accentBg, BACKDROP, TextAttributes.BOLD);
    buffer.drawText(` ${about}`, x0 + where.length + 1, y, CAPTION, BACKDROP);
    buffer.drawText(keys, x0 + Math.max(0, width - keys.length - 1), y, DIM, BACKDROP);

    const areaW = width - 2;
    const areaH = height - 2;
    const say = (text: string) =>
      buffer.drawText(text, x0 + Math.max(0, Math.floor((width - text.length) / 2)), y0 + Math.floor(areaH / 2), DIM, BACKDROP);
    const src = this.source();
    if (!src) return say("taking the page's pictures…");
    if (areaW < 4 || areaH < 2) return;

    // Its part of the screenshot, as the view's cells fit it without stretching.
    const { image, scale } = src;
    const left = Math.max(0, Math.round(pic.r[0] * scale));
    const top = Math.max(0, Math.round(pic.r[1] * scale));
    const cw = Math.min(image.width, Math.round((pic.r[0] + pic.r[2]) * scale)) - left;
    const ch = Math.min(image.height, Math.round((pic.r[1] + pic.r[3]) * scale)) - top;
    if (cw < 1 || ch < 1) return say('this picture is past where the screenshot of the page reached');
    const shape = (cw / ch) * cellAspect(this._ctx); // columns per row
    let cols = Math.min(areaW, Math.round(areaH * shape));
    let rows = Math.round(cols / shape);
    if (rows > areaH) {
      rows = areaH;
      cols = Math.round(rows * shape);
    }
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    const ix = x0 + 1 + Math.floor((areaW - cols) / 2);
    const iy = y0 + Math.floor((areaH - rows) / 2);
    const [pw, ph] = pixelsFor(this._ctx, cols, rows);
    buffer.drawImage(image, ix, iy, cols, rows, pw, ph, left, top, cw, ch, 'auto');
  }

  // The wheel steps through the pictures; a click goes to the next.
  protected onMouseEvent(e: MouseEvent) {
    if (e.type === 'scroll' && e.scroll) this.step(e.scroll.direction === 'up' ? -1 : 1);
    else if (e.type === 'down' && e.button === 0) this.step(1);
  }
}
