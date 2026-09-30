// inspect: what a developer would look up about one element in the browser's
// own tools, as text. inspect.js reads it in the page; the session adds what
// the page's script can't see (what covers it, its event listeners, the CSS
// rules behind its styles); this says it all in words.

import type { ListenerInfo, RuleInfo } from './browser.ts';

/** What inspect.js returns about an element (see there). */
export interface Found {
  error?: string;
  tag: string;
  open: string; // its opening tag
  html: string; // its markup, cut if long
  path: string[]; // what it's inside of, outermost first: body, main, form#checkout
  selector: string | null; // a CSS selector that finds it and nothing else
  shadow: string; // the host of the shadow root it's in, if it's in one
  children: number;
  role: string;
  roleGiven: boolean; // by a role attribute, rather than by its tag
  name: string; // its accessible name, and the attribute or text it comes from
  from: string;
  text: string;
  box: { x: number; y: number; w: number; h: number };
  window: { w: number; h: number; sx: number; sy: number };
  hidden: string; // why it can't be seen, or ''
  pointer: boolean; // pointer-events: none
  colors: { color: string; background?: string; image?: string; behind?: string; contrast?: number };
  font: string;
  textStyle: string[];
  layout: string[];
  boxStyle: string[];
  flow: string[];
  other: string[];
  extra: [string, string][];
}

/** Everything inspect tells about an element. */
export interface Inspection extends Omit<Found, 'error' | 'window' | 'pointer'> {
  ref: number;
  label: string; // as snapshots show it
  frame: boolean; // in a frame from another site
  value?: string; // what a field holds (a password's is masked)
  states: string[];
  place: string; // where its box is against the window
  visible: string; // "yes", or "no: …"
  clickable: string; // "yes", or why not
  rules?: RuleInfo[];
  listeners?: Heard[]; // `on`: '' for the element itself, else what it's on
  notes: string[]; // what couldn't be read, and why
}

const FROM: Record<string, string> = {
  labelledby: 'from what aria-labelledby points at',
  'aria-label': 'from its aria-label',
  label: 'from its label',
  value: 'from its value',
  alt: 'from its alt text',
  content: 'from its text',
  title: 'from its title',
  placeholder: 'from its placeholder, which goes when typing starts: not a label',
};

// Events a person causes: the ones worth telling of on what's around an element (a framework listens for every kind, at the top).
const CAUSED = /^(click|dblclick|auxclick|contextmenu|mousedown|mouseup|pointerdown|pointerup|touchstart|touchend|keydown|keyup|keypress|input|change|submit|focusin|focusout)$/;

type Heard = ListenerInfo & { on: string };

// A line this far along is a minified file's: its column is the only way to find the place.
const MINIFIED = 200;

/**
 * Listeners as lines, those on the same thing with their handlers in the same
 * place said together: a framework listens for every kind of event at the
 * top, and hands them on from one function.
 */
function heardLines(list: Heard[], short: (where: string) => string): string[] {
  const groups = new Map<string, Heard[]>();
  for (const l of list) {
    const key = `${l.on}\n${l.where ?? ''}\n${l.capture}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  return [...groups.values()].map((g) => {
    const kinds = [...new Set(g.map((l) => l.type))];
    const said = kinds.length > 5 ? `${kinds.slice(0, 4).join(', ')} and ${kinds.length - 4} more kinds` : kinds.join(', ');
    const { on, capture, where } = g[0];
    const column = g.every((l) => l.column === g[0].column) ? g[0].column : undefined;
    const at = where ? `${short(where)}${column && column > MINIFIED ? `:${column}` : ''}` : '';
    return `${said}${on ? `, on ${on}` : ''}${capture ? ' (capturing)' : ''}  ${at}`.trimEnd();
  });
}

/**
 * The inspection as text: a line or a few per thing, named in a column.
 * `short` turns a script's or stylesheet's address and line into file:line.
 */
export function inspectText(i: Inspection, short: (where: string) => string): string {
  const out: string[] = [i.label, i.open];
  const row = (name: string, ...lines: string[]) => {
    lines.filter(Boolean).forEach((l, n) => out.push(`${(n ? '' : name).padEnd(10)} ${l}`));
  };
  // A deep place is told by its ends: where it starts, and what's nearest.
  const path = i.path.length > 7 ? [i.path[0], '…', ...i.path.slice(-5)] : i.path;
  const inside = [...path, ...(i.shadow ? [`(the shadow root of ${i.shadow})`] : [])].join(' › ');
  row('in', `${inside || 'the page itself'}${i.frame ? ' · in a frame from another site' : ''}`);
  row('selector', i.selector ?? "none that finds only it: it has no id, and its classes and place aren't its alone");
  const role = i.role ? `role ${i.role}${i.roleGiven ? '' : ' (from its tag)'}` : 'no role';
  row('name', i.name ? `"${i.name}", ${FROM[i.from] ?? `from its ${i.from}`} · ${role}` : `none · ${role}`);
  if (i.value !== undefined) row('value', i.value === '' ? '(empty)' : `"${i.value}"`);
  if (i.states.length) row('states', i.states.join(', '));
  if (i.text && i.text !== i.name) row('text', i.text);
  row('box', `${i.box.w}×${i.box.h} at ${i.box.x},${i.box.y} · ${i.place}`);
  row('visible', i.visible);
  row('clickable', i.clickable);

  const c = i.colors;
  const on = c.background ? `on ${c.background}` : c.image ? `over ${c.image}` : c.behind ? `on ${c.behind} (what's behind it)` : "over something whose color can't be told";
  row('colors', `${c.color} ${on}${c.image && c.background ? `, under ${c.image}` : ''}${c.contrast !== undefined ? ` · contrast ${c.contrast}:1` : ''}`);
  row('font', [i.font, ...i.textStyle].join(' · '));
  row('layout', [...i.layout, ...i.boxStyle].join(' · '), ...i.flow);
  if (i.other.length) row('other', i.other.join(' · '));
  if (i.extra.length) row('css', ...i.extra.map(([p, v]) => `${p}: ${v}`));

  if (i.rules) {
    // A rule that only sets variables (a framework's reset sets dozens) says nothing of how it looks.
    const telling = i.rules.filter((r) => !r.declarations.every((d) => d.startsWith('--')));
    const own = telling.filter((r) => !r.inherited);
    const above = telling.filter((r) => r.inherited);
    const say = (r: RuleInfo) => {
      const from = r.inherited ? `from ${i.path.at(-r.inherited) ?? 'html'}: ` : '';
      const body = r.declarations.join('; ');
      const rule = `${r.media ? `@media ${r.media} ` : ''}${r.selector} { ${body.length > 160 ? body.slice(0, 159) + '…' : body} }`;
      const at = r.where ? `${short(r.where)}${r.column && r.column > MINIFIED ? `:${r.column}` : ''}` : "(a style the page's script made)";
      return `${from}${rule}  ${at}`;
    };
    const lines = [...own.slice(0, 12).map(say), ...above.slice(0, 8).map(say)];
    const more = Math.max(0, own.length - 12) + Math.max(0, above.length - 8);
    if (more) lines.push(`… and ${more} more (--json has them all)`);
    row('rules', ...(lines.length ? lines : ['none of the page\'s own: it looks as the browser draws it, and as what it\'s inside of makes it']));
  }
  if (i.listeners) {
    const own = i.listeners.filter((l) => !l.on);
    const around = i.listeners.filter((l) => l.on && CAUSED.test(l.type));
    const lines = [...heardLines(own, short), ...heardLines(around, short)];
    if (!lines.length) lines.push("none on it, or around it for clicks and keys: only what its tag does by itself happens");
    else if (!own.length) lines.unshift('none on it itself; around it:');
    row('listeners', ...lines.slice(0, 14), ...(lines.length > 14 ? [`… and ${lines.length - 14} more (--json has them all)`] : []));
  }
  row('html', i.html);
  for (const n of i.notes) out.push(`note: ${n}`);
  return out.join('\n');
}
