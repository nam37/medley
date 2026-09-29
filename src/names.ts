// Elements by name: "Add to cart", or "button Add to cart" to say which kind.
// The session looks names up in place of ref numbers (see Session.resolveRef),
// and recording writes steps with names (see script.ts), since numbers change
// from page to page and names mostly don't.

export const KINDS = new Set([
  'link', 'button', 'textbox', 'password', 'combobox', 'select', 'checkbox', 'radio', 'slider',
  'tab', 'menuitem', 'option', 'file', 'draggable', 'clickable',
]);

/** A ref's kind and name from how snapshots show it: [7]Docs, [8 button "Save"], [9 clickable]Card text. */
export function parseLabel(label: string): { kind: string; name: string } {
  const m = /^\[\d+(?: (\w+))?(?: "((?:[^"\\]|\\.)*)")?\](.*)$/.exec(label);
  if (!m) return { kind: '', name: label };
  return { kind: m[1] ?? 'link', name: (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]).trim() };
}

/**
 * The ref whose name is `query` (exactly, then at the start, then anywhere,
 * in any case), of the kind it names first if it does ("button Save").
 * Several that fit equally well are an error listing them; none is null, or
 * an error when `surely`.
 */
export function matchRef(labels: Map<number, string>, query: string, surely: boolean): number | null {
  let kind = '';
  let name = query.replace(/^["']|["']$/g, '');
  const m = /^(\w+)\s+(.+)$/.exec(name);
  if (m && KINDS.has(m[1].toLowerCase())) {
    kind = m[1].toLowerCase();
    name = m[2].replace(/^["']|["']$/g, '');
  }
  const want = name.toLowerCase();
  const pool = [...labels].map(([ref, label]) => ({ ref, label, ...parseLabel(label) })).filter((p) => !kind || p.kind === kind);
  for (const fits of [(n: string) => n === want, (n: string) => n.startsWith(want), (n: string) => n.includes(want)]) {
    const found = pool.filter((p) => p.name && fits(p.name.toLowerCase()));
    if (found.length === 1) return found[0].ref;
    if (found.length > 1) {
      const list = found.slice(0, 8).map((f) => f.label).join(', ');
      throw new Error(`"${query}" fits ${found.length} elements: ${list}${found.length > 8 ? ', …' : ''}; use its number, or say which kind ("button ${name}")`);
    }
  }
  if (!surely) return null;
  throw new Error(`nothing on the page is called "${query}"; find or snapshot shows what is`);
}

/**
 * What to call a ref so that matchRef finds it and nothing else: its kind and
 * name ("button Add to cart"), or for a long name the fewest of its first
 * words that do. Null when its name doesn't single it out (two "Add to cart"
 * buttons) or it has none.
 */
export function nameFor(labels: Map<number, string>, ref: number): string | null {
  const label = labels.get(ref);
  if (!label) return null;
  const { kind, name } = parseLabel(label);
  if (!kind || !name) return null;
  const finds = (query: string) => {
    try {
      return matchRef(labels, query, false) === ref;
    } catch {
      return false;
    }
  };
  const words = name.split(' ');
  // A card's link reads as all of its text; its first words are enough, and read better.
  if (name.length > 50) {
    for (let n = 4; n < words.length; n += 2) {
      const query = `${kind} ${words.slice(0, n).join(' ')}`;
      if (query.length > 60) break;
      if (finds(query)) return query;
    }
  }
  const query = `${kind} ${name}`;
  return finds(query) ? query : null;
}
