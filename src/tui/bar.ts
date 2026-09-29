// A one-row bar of styled segments: some on the left, some right-aligned.
// When both don't fit, the right side gets at most 40% and the left is cut short (with …).

import { Renderable, type MouseEvent, type OptimizedBuffer, type RenderContext, type RenderableOptions, type RGBA } from '@opentui/core';
import { THEME } from './theme.ts';

export interface Segment {
  text: string;
  fg?: RGBA;
  bg?: RGBA;
  attrs?: number;
}

export interface BarOptions extends RenderableOptions<Bar> {
  bg?: RGBA;
  fg?: RGBA;
  /** A click, at column `x` of the bar; `right` is where the right-hand segments start (-1: none). */
  onClick?: (x: number, right: number) => void;
}

/** The longest prefix of `text` that fits in `width` cells, ending in … if cut. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (Bun.stringWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = Bun.stringWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return out + '…';
}

const widthOf = (segments: Segment[]) => segments.reduce((n, s) => n + Bun.stringWidth(s.text), 0);

export class Bar extends Renderable {
  private left: Segment[] = [];
  private right: Segment[] = [];
  private bg?: RGBA;
  private fg: RGBA;
  private onClick?: (x: number, right: number) => void;
  private rightStart = -1; // where the right-hand segments were last drawn

  constructor(ctx: RenderContext, { bg, fg, onClick, ...options }: BarOptions) {
    super(ctx, { height: 1, ...options });
    this.onClick = onClick;
    this.bg = bg;
    this.fg = fg ?? (bg ? THEME.barFg : THEME.text);
  }

  set(left: Segment[], right: Segment[] = []) {
    this.left = left;
    this.right = right;
    this.requestRender();
  }

  get contentWidth(): number {
    return widthOf(this.left) + widthOf(this.right);
  }

  protected renderSelf(buffer: OptimizedBuffer) {
    const { screenX: x0, screenY: y, width } = this;
    if (this.bg) buffer.fillRect(x0, y, width, 1, this.bg);
    const leftWidth = widthOf(this.left);
    const rightWidth = Math.min(widthOf(this.right), Math.max(width - leftWidth - 2, Math.floor(width * 0.4)));
    const draw = (segments: Segment[], x: number, limit: number) => {
      for (const s of segments) {
        const text = fit(s.text, limit - x);
        if (!text) break;
        buffer.drawText(text, x, y, s.fg ?? this.fg, s.bg ?? this.bg, s.attrs ?? 0);
        x += Bun.stringWidth(text);
      }
    };
    draw(this.left, x0, x0 + width - (rightWidth ? rightWidth + 2 : 0));
    draw(this.right, x0 + width - rightWidth, x0 + width);
    this.rightStart = rightWidth ? width - rightWidth : -1;
  }

  protected onMouseEvent(e: MouseEvent) {
    if (e.type === 'down' && e.button === 0) this.onClick?.(e.x - this.screenX, this.rightStart);
  }
}
