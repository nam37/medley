// Checks: what `expect` can ask of a page, so that whoever changed it (an
// agent, a person, a script replayed after every save) knows the change worked
// rather than guessing from the text. One expect can ask several things, and
// all of them must be so:
//
//   expect Thanks for your order                      the text is on the page
//   expect --gone Loading                             it isn't
//   expect --count 3 button Remove                    there are 3 of them
//   expect --url /cart --title Cart                   the address and the title have these
//   expect --value "textbox Email=ada@example.com"    a field holds exactly this
//   expect --disabled "button Place order"            a control's state
//   expect --no-errors                                the page logged no errors

import { KINDS } from './names.ts';

/** States a control can be checked for: the words snapshots show after it, and "enabled" for not disabled. */
export const STATES = ['checked', 'unchecked', 'enabled', 'disabled', 'focused', 'expanded', 'collapsed', 'selected', 'pressed'] as const;
export type State = (typeof STATES)[number];

export type Check =
  | { kind: 'text'; text: string; gone?: boolean } // on the page (its text or title, in any case), or not
  | { kind: 'count'; text: string; n: number } // there n times; "button Remove" counts elements of a kind
  | { kind: 'url'; text: string } // the address has it
  | { kind: 'title'; text: string } // the title has it, in any case
  | { kind: 'value'; ref: string; text: string } // a field holds exactly this (a checkbox: on or off)
  | { kind: 'state'; ref: string; state: State }
  | { kind: 'errors' }; // no errors logged, none of its own site's requests failed

export const EXPECT_USAGE = [
  'usage: expect <text> | --gone <text> | --count <n> <text, or a kind of element: button Remove>',
  '       | --url <text> | --title <text> | --value <field>=<text>',
  `       | --${STATES.join(' <ref> | --')} <ref>`,
  '       | --no-errors   [--within <seconds>]   (several at once: all must be so)',
].join('\n');

const isState = (s: unknown): s is State => (STATES as readonly string[]).includes(String(s));
const given = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * The checks an expect command asks for: its `checks`, or (from an agent)
 * text with gone or count, url, title, fields ([{ ref, value }], as fill
 * takes them), states ([{ ref, is }]) and no_errors.
 */
export function checksOf(args: Record<string, unknown> = {}): Check[] {
  const out: Check[] = [];
  const bad = (why: string) => new Error(`${why}\n${EXPECT_USAGE}`);
  const count = (n: unknown) => {
    const count = Number(n);
    if (!Number.isInteger(count) || count < 0) throw bad(`"${n}" isn't a count`);
    return count;
  };
  if (Array.isArray(args.checks)) {
    for (const c of args.checks as Record<string, unknown>[]) {
      const text = String(c?.text ?? '');
      const ref = String(c?.ref ?? '').trim();
      switch (c?.kind) {
        case 'text':
          if (!text.trim()) throw bad('a check for text needs the text');
          out.push({ kind: 'text', text: text.trim(), ...(c.gone ? { gone: true } : {}) });
          break;
        case 'count':
          if (!text.trim()) throw bad('a count needs the text, or the kind of element, to count');
          out.push({ kind: 'count', text: text.trim(), n: count(c.n) });
          break;
        case 'url':
        case 'title':
          if (!text.trim()) throw bad(`a check of the ${c.kind === 'url' ? 'address' : 'title'} needs some text`);
          out.push({ kind: c.kind, text: text.trim() });
          break;
        case 'value':
          if (!ref) throw bad('a check of a value needs its field');
          out.push({ kind: 'value', ref, text });
          break;
        case 'state':
          if (!ref || !isState(c.state)) throw bad(`a check of a state needs an element, and one of ${STATES.join(', ')}`);
          out.push({ kind: 'state', ref, state: c.state });
          break;
        case 'errors':
          out.push({ kind: 'errors' });
          break;
        default:
          throw bad(`"${c?.kind}" isn't a kind of check`);
      }
    }
    if (!out.length) throw bad('expect needs something to check');
    return out;
  }
  const checks: Record<string, unknown>[] = [];
  const text = String(args.text ?? '');
  if (given(args.count)) checks.push({ kind: 'count', text, n: args.count });
  else if (text.trim()) checks.push({ kind: 'text', text, gone: !!args.gone });
  if (given(args.url)) checks.push({ kind: 'url', text: args.url });
  if (given(args.title)) checks.push({ kind: 'title', text: args.title });
  const fields = Array.isArray(args.fields)
    ? (args.fields as { ref?: unknown; value?: unknown }[]).map((f) => [f?.ref, f?.value])
    : args.fields && typeof args.fields === 'object'
      ? Object.entries(args.fields as Record<string, unknown>)
      : [];
  for (const [ref, value] of fields) checks.push({ kind: 'value', ref, text: value ?? '' });
  for (const s of Array.isArray(args.states) ? (args.states as Record<string, unknown>[]) : []) {
    checks.push({ kind: 'state', ref: s?.ref, state: s?.is ?? s?.state });
  }
  if (args.no_errors || args.noErrors) checks.push({ kind: 'errors' });
  return checksOf({ checks });
}

/** What a count counts: elements of a kind ("button Remove", "checkbox"), when it starts with one; otherwise text. */
export function countOf(text: string): { kind: string; name: string } | null {
  const m = /^(\w+)(?:\s+(.+))?$/.exec(text.trim());
  if (!m || !KINDS.has(m[1].toLowerCase())) return null;
  return { kind: m[1].toLowerCase(), name: (m[2] ?? '').replace(/^["']|["']$/g, '') };
}

/** Whether a value given for a checkbox or radio button means checked (as fill takes them): anything but off, no, false, 0. */
export const meansOn = (value: string) => !/^(off|no|false|0|unchecked)?$/i.test(value.trim());

/** A check in a few words, for saying what's being looked for. */
export function checkName(c: Check): string {
  switch (c.kind) {
    case 'text':
      return c.gone ? `"${c.text}" to be gone` : `"${c.text}"`;
    case 'count':
      return `${c.n} × "${c.text}"`;
    case 'url':
      return `the address to have "${c.text}"`;
    case 'title':
      return `the title to have "${c.text}"`;
    case 'value':
      return `what ${c.ref} holds`;
    case 'state':
      return `${c.ref} to be ${c.state}`;
    case 'errors':
      return 'no errors';
  }
}
