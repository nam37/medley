// The refs pull-down: every ref on the page, one per row (number, what it is,
// where a link goes), filtered by typing, scrolled with the keys or the wheel,
// and opened with Enter or a click. The app owns the box around it and the keys.

import { Renderable, type MouseEvent, type OptimizedBuffer, type RenderContext, type RenderableOptions } from '@opentui/core';
import { fit } from './bar.ts';
import { THEME } from './theme.ts';

export interface RefItem {
  ref: number;
  link: boolean;
  text: string; // a link's text, or a control's kind and name: button "Save"
  url?: string;
}

export interface RefListOptions extends RenderableOptions<RefList> {
  onPick?: (item: RefItem) => void;
}

/** Items from the page's labels ("[7]Docs", "[8 button "Save"]") and link targets. */
export function refItems(labels: [number, string][], hrefs: [number, string][]): RefItem[] {
  const urls = new Map(hrefs);
  return labels
    .map(([ref, label]) => {
      const link = label.startsWith(`[${ref}]`);
      const text = link ? label.slice(`[${ref}]`.length) : label.replace(/^\[\d+ /, '').replace(/\]$/, '');
      return { ref, link, text: text || '(no text)', url: urls.get(ref) };
    })
    .sort((a, b) => a.ref - b.ref);
}

export class RefList extends Renderable {
  private all: RefItem[] = [];
  private shown: RefItem[] = [];
  private query = '';
  private at = 0; // the selected row, in `shown`
  private top = 0; // the first visible row
  private onPick?: (item: RefItem) => void;

  constructor(ctx: RenderContext, { onPick, ...options }: RefListOptions) {
    super(ctx, options);
    this.onPick = onPick;
  }

  setItems(items: RefItem[]) {
    this.all = items;
    this.query = '';
    this.refilter();
  }

  get filter(): string {
    return this.query;
  }

  get count(): { shown: number; all: number } {
    return { shown: this.shown.length, all: this.all.length };
  }

  get selected(): RefItem | undefined {
    return this.shown[this.at];
  }

  setFilter(query: string) {
    this.query = query;
    this.refilter();
  }

  /** Move the selection by `delta` rows (a page is the list's height). */
  move(delta: number) {
    if (!this.shown.length) return;
    this.at = Math.max(0, Math.min(this.shown.length - 1, this.at + delta));
    this.keepInView();
  }

  get pageSize(): number {
    return Math.max(1, this.height - 1);
  }

  private refilter() {
    const q = this.query.trim().toLowerCase();
    const n = /^\d+$/.test(q) ? Number(q) : NaN;
    this.shown = q
      ? this.all.filter((i) => String(i.ref) === q || i.text.toLowerCase().includes(q) || (i.url ?? '').toLowerCase().includes(q))
      : this.all;
    // A typed number puts that ref first.
    if (!Number.isNaN(n)) this.shown = [...this.shown.filter((i) => i.ref === n), ...this.shown.filter((i) => i.ref !== n)];
    this.at = 0;
    this.top = 0;
    this.requestRender();
  }

  private keepInView() {
    const h = Math.max(1, this.height);
    if (this.at < this.top) this.top = this.at;
    else if (this.at >= this.top + h) this.top = this.at - h + 1;
    this.requestRender();
  }

  protected renderSelf(buffer: OptimizedBuffer) {
    const { screenX: x0, screenY: y0, width, height } = this;
    buffer.fillRect(x0, y0, width, height, THEME.barBg);
    if (!this.shown.length) {
      buffer.drawText(fit(this.all.length ? `nothing matches "${this.query}"` : 'no refs on this page', width - 2), x0 + 1, y0, THEME.barDim, THEME.barBg, 0);
      return;
    }
    const numberWidth = String(this.all.at(-1)?.ref ?? 0).length + 2;
    for (let row = 0; row < height; row++) {
      const item = this.shown[this.top + row];
      if (!item) break;
      const selected = this.top + row === this.at;
      const bg = selected ? THEME.accentBg : THEME.barBg;
      const y = y0 + row;
      if (selected) buffer.fillRect(x0, y, width, 1, bg);
      let x = x0 + 1;
      const number = `[${item.ref}]`.padStart(numberWidth);
      buffer.drawText(number, x, y, selected ? THEME.accentFg : item.link ? THEME.link : THEME.control, bg, 0);
      x += number.length + 1;
      const room = x0 + width - 1 - x;
      const url = item.url?.replace(/^https?:\/\//, '') ?? '';
      // The text gets what it needs, up to 60% of the row; the address the rest.
      const text = fit(item.text, Math.max(8, Math.min(Bun.stringWidth(item.text), url ? Math.floor(room * 0.6) : room)));
      buffer.drawText(text, x, y, selected ? THEME.accentFg : THEME.barFg, bg, 0);
      x += Bun.stringWidth(text) + 2;
      if (url && x < x0 + width - 4) buffer.drawText(fit(`→ ${url}`, x0 + width - 1 - x), x, y, selected ? THEME.accentFg : THEME.barDim, bg, 0);
    }
  }

  protected onMouseEvent(e: MouseEvent) {
    if (e.type === 'scroll' && e.scroll) {
      if (e.scroll.direction === 'up' || e.scroll.direction === 'down') this.move(e.scroll.direction === 'up' ? -3 : 3);
      return;
    }
    if (e.type !== 'down' || e.button !== 0) return;
    const i = this.top + (e.y - this.screenY);
    const item = this.shown[i];
    if (!item) return;
    this.at = i;
    this.requestRender();
    this.onPick?.(item);
  }
}
