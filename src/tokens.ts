// Finding refs in rendered text: [7] is a link (or the prefix of a card-sized
// link), [8 button "Save" = "x" focused] is any other control.

export const TOKEN =
  /\[(\d+)\]|\[(\d+) ([a-z]+)((?: "(?:[^"\\]|\\.)*")?(?: = "(?:[^"\\]|\\.)*")?(?: [a-z]+)*)\]/g;

const PARTS = /^(?: "((?:[^"\\]|\\.)*)")?(?: = "((?:[^"\\]|\\.)*)")?((?: [a-z]+)*)$/;

export interface Token {
  ref: number;
  kind: string; // "link" for [7]
  start: number; // index of "[" in the line
  end: number; // index after "]"
  name?: string;
  value?: string;
  states: string[];
}

const unescape = (s: string) => s.replace(/\\(.)/g, '$1');

export function findTokens(line: string): Token[] {
  const out: Token[] = [];
  for (const m of line.matchAll(TOKEN)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (m[1]) {
      out.push({ ref: Number(m[1]), kind: 'link', start, end, states: [] });
      continue;
    }
    const parts = PARTS.exec(m[4]) ?? [];
    out.push({
      ref: Number(m[2]),
      kind: m[3],
      start,
      end,
      name: parts[1] === undefined ? undefined : unescape(parts[1]),
      value: parts[2] === undefined ? undefined : unescape(parts[2]),
      states: (parts[3] ?? '').trim().split(' ').filter(Boolean),
    });
  }
  return out;
}
