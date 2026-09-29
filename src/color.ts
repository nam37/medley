// ANSI color for terminal output. It works on finished text, so the renderer,
// the session and the MCP server can all stay plain.

import { TOKEN } from './tokens.ts';

const wrap = (on: string, s: string, off = '39') => `\x1b[${on}m${s}\x1b[${off}m`;

function tokens(line: string): string {
  return line.replace(TOKEN, (t) => (t.includes(' ') ? wrap('33', t) : wrap('36', t)));
}

export function colorize(text: string): string {
  let fenced = false;
  let diff = false; // after the first @@ line, lines are diff output
  return text
    .split('\n')
    .map((line, i) => {
      if (/^@@ .* @@$|^@@$/.test(line)) {
        diff = true;
        return wrap('36', line);
      }
      if (diff) {
        if (line.startsWith('+ ')) return wrap('32', line);
        if (line.startsWith('- ')) return wrap('31', line);
        return wrap('2', line, '22');
      }
      if (line.startsWith('```')) fenced = !fenced;
      if (fenced || line.startsWith('```')) return line;
      if (/^#{1,6} /.test(line)) return wrap('1', tokens(line), '22');
      if (line.startsWith('── ')) return wrap('35', line);
      if (i === 0) return wrap('1', tokens(line), '22');
      return tokens(line);
    })
    .join('\n');
}
