// Line diff between two snapshots of the same page (Myers' algorithm), shown
// as hunks labelled with the landmark and heading they fall under:
//
//   @@ header › nav "Primary" @@
//     [4]Pricing
//   - [5 button "Open menu" collapsed]
//   + [5 button "Open menu" expanded]
//   + [31]Settings

type Op = [' ' | '-' | '+', string];

export interface Diff {
  text: string;
  added: number;
  removed: number;
}

/** Shortest edit script from a to b, or null if it needs more than maxD edits. */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3); // v[off + k]: furthest x reached on diagonal k
  const trace: Int32Array[] = []; // v before each round, for k in [-d-1, d+1]
  let found = -1;
  search: for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break search;
      }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push([' ', a[x]]);
    }
    if (d > 0) ops.push(x === prevX ? ['+', b[y - 1]] : ['-', a[x - 1]]);
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** The landmark and heading a line sits under, from the lines before it. */
function section(ops: Op[], before: number): string {
  let heading = '';
  for (let i = before - 1; i >= 0; i--) {
    const [t, line] = ops[i];
    if (t === '-') continue; // label by the page as it is now
    if (!heading && /^#{1,6} /.test(line)) heading = line;
    const lm = /^── (.*) ──$/.exec(line);
    if (lm) return heading ? `${lm[1]} › ${heading}` : lm[1];
  }
  return heading;
}

/** Where a line of a page sits: the landmark and heading above it, as a hunk label names them. */
export function whereIs(lines: string[], index: number): string {
  return section(lines.map((l): Op => [' ', l]), index);
}

/** Edit script from a to b, or null if they differ too much to be worth diffing. */
function editScript(a: string[], b: string[]): Op[] | null {
  // Diff only the middle: pages usually change in one place.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const middle = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf), 400);
  if (!middle) return null;
  return [
    ...a.slice(0, pre).map((l): Op => [' ', l]),
    ...middle,
    ...a.slice(a.length - suf).map((l): Op => [' ', l]),
  ];
}

/** Indexes of the lines in b that are new or changed since a. Empty if nearly everything changed. */
export function changedLines(a: string[], b: string[]): Set<number> {
  const changed = new Set<number>();
  let bi = 0;
  for (const [t] of editScript(a, b) ?? []) {
    if (t === '+') changed.add(bi);
    if (t !== '-') bi++;
  }
  return changed;
}

export function diffLines(a: string[], b: string[], context = 1): Diff | null {
  const ops = editScript(a, b);
  if (!ops) return null;

  // Group changes, with `context` unchanged lines around each group.
  const hunks: [number, number][] = [];
  ops.forEach(([t], i) => {
    if (t === ' ') return;
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = end;
    else hunks.push([start, end]);
  });

  const out: string[] = [];
  for (const [start, end] of hunks) {
    const firstChange = ops.findIndex(([t], i) => i >= start && t !== ' ');
    const label = section(ops, firstChange);
    out.push(label ? `@@ ${label} @@` : '@@');
    for (let i = start; i < end; i++) {
      const [t, line] = ops[i];
      out.push(line ? `${t} ${line}` : t.trim());
    }
  }
  return {
    text: out.join('\n'),
    added: ops.filter(([t]) => t === '+').length,
    removed: ops.filter(([t]) => t === '-').length,
  };
}
