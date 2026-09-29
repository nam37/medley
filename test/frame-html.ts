// Turns a test renderer's frame into HTML: one <span> per run of cells with
// the same colors and attributes, joined into lines.

import { TextAttributes } from '@opentui/core';
import type { createTestRenderer } from '@opentui/core/testing';

type Spans = ReturnType<Awaited<ReturnType<typeof createTestRenderer>>['captureSpans']>;
type Color = { buffer: ArrayLike<number> };

const css = (c: Color) => `rgba(${c.buffer[0]},${c.buffer[1]},${c.buffer[2]},${c.buffer[3] / 255})`;
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The frame's lines as HTML, for a <pre> whose own colors are the terminal's default foreground and background. */
export function frameHtml(frame: Spans, background = '#1e1e1e'): string {
  return frame.lines
    .map((line) =>
      line.spans
        .map((s) => {
          let [fg, bg] = [css(s.fg), s.bg.buffer[3] ? css(s.bg) : 'transparent'];
          if (s.attributes & TextAttributes.INVERSE) [fg, bg] = [bg === 'transparent' ? background : bg, fg];
          const style = [`color:${fg}`, `background:${bg}`];
          if (s.attributes & TextAttributes.BOLD) style.push('font-weight:bold');
          if (s.attributes & TextAttributes.UNDERLINE) style.push('text-decoration:underline');
          return `<span style="${style.join(';')}">${escape(s.text)}</span>`;
        })
        .join(''),
    )
    .join('\n');
}
