// An accessibility check of the page (medley audit): what audit.js found,
// grouped by rule, with the refs of what's wrong where it has them, and how to
// fix it. The rules are the WCAG 2.2 A and AA ones a page can be checked for
// by looking at it; the warnings are best practice.

export interface Finding {
  rule: string;
  ref?: number; // in the page's own numbering (see Session.audit)
  what: string; // the element, as a developer finds it: tag, id or class, text
  detail?: string;
  key?: string; // findings with the same key are one case (a pair of colors, a link text)
}

export interface AuditResult {
  url: string;
  title: string;
  findings: Finding[];
  checked: { texts: number; controls: number; pictures: number; headings: number; frames: number; unread: number };
}

interface Rule {
  level: 'problem' | 'warning';
  wcag: string;
  says: (n: number) => string;
  fix: string;
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`);

// In the order they're listed.
const RULES: Record<string, Rule> = {
  alt: {
    level: 'problem',
    wcag: '1.1.1',
    says: (n) => `${count(n, 'picture has', 'pictures have')} no text alternative`,
    fix: 'alt="what it shows", or alt="" when it is only decoration',
  },
  name: {
    level: 'problem',
    wcag: '4.1.2',
    says: (n) => `${count(n, 'control has', 'controls have')} no name (a screen reader says only "button" or "link")`,
    fix: 'visible text, a <label>, or aria-label="…" for an icon',
  },
  contrast: {
    level: 'problem',
    wcag: '1.4.3',
    says: (n) => `${count(n, 'piece of text has', 'pieces of text have')} too little contrast`,
    fix: 'darker text or a lighter background (or the other way round)',
  },
  keyboard: {
    level: 'problem',
    wcag: '2.1.1',
    says: (n) => `${count(n, "control can't", "controls can't")} be reached with the keyboard`,
    fix: 'a <button> or a link; or tabindex="0", a role and a key handler',
  },
  'hidden-focus': {
    level: 'problem',
    wcag: '4.1.2',
    says: (n) => `${count(n, 'part of the page is', 'parts of the page are')} hidden from screen readers (aria-hidden) but can be tabbed into`,
    fix: 'remove aria-hidden, or take what is inside out of the tab order (inert)',
  },
  'frame-title': {
    level: 'problem',
    wcag: '4.1.2',
    says: (n) => `${count(n, 'frame has', 'frames have')} no title`,
    fix: 'title="what it holds"',
  },
  lang: {
    level: 'problem',
    wcag: '3.1.1',
    says: () => "the page doesn't say what language it's in",
    fix: '<html lang="en"> (or its language)',
  },
  title: {
    level: 'problem',
    wcag: '2.4.2',
    says: () => 'the page has no title',
    fix: '<title>what the page is</title>',
  },
  zoom: {
    level: 'problem',
    wcag: '1.4.4',
    says: () => 'the page stops people zooming in',
    fix: 'take user-scalable=no and maximum-scale out of the viewport meta tag',
  },
  placeholder: {
    level: 'warning',
    wcag: '3.3.2',
    says: (n) => `${count(n, 'field is', 'fields are')} labelled only by a placeholder, which goes away when you type`,
    fix: 'a <label>, or aria-label',
  },
  role: {
    level: 'warning',
    wcag: '4.1.2',
    says: (n) => `${count(n, 'clickable element is', 'clickable elements are')} not a button or link, so a screen reader doesn't say what it is`,
    fix: 'a <button> or a link, or role="button"',
  },
  'link-text': {
    level: 'warning',
    wcag: '2.4.4',
    says: (n) => `${count(n, 'link says', 'links say')} only something like "Read more", not where it goes`,
    fix: 'link text that names where it goes, or aria-label',
  },
  headings: {
    level: 'warning',
    wcag: '1.3.1',
    says: (n) => `headings skip a level ${count(n, 'time', 'times')}`,
    fix: 'one level at a time: h2, then h3 under it',
  },
  'no-h1': {
    level: 'warning',
    wcag: '1.3.1',
    says: () => 'the page has headings but no h1',
    fix: 'an h1 that says what the page is',
  },
  main: {
    level: 'warning',
    wcag: '1.3.1',
    says: () => "the page has no main landmark, so a screen reader can't jump to its content",
    fix: '<main> around the content',
  },
  tabindex: {
    level: 'warning',
    wcag: '2.4.3',
    says: (n) => `${count(n, 'element has', 'elements have')} a tabindex above 0, which reorders the tab key`,
    fix: 'tabindex="0", and the element where it belongs in the page',
  },
  'alt-file': {
    level: 'warning',
    wcag: '1.1.1',
    says: (n) => `${count(n, 'picture has', 'pictures have')} a file name for its text alternative`,
    fix: 'alt that says what it shows',
  },
  autoplay: {
    level: 'warning',
    wcag: '1.4.2',
    says: (n) => `${count(n, 'video or sound plays', 'videos or sounds play')} with sound by itself`,
    fix: 'muted, or a way to stop it at the start of the page',
  },
};

const EXAMPLES = 6;

/**
 * The audit as text. `labelOf` gives a finding's ref as the page's snapshot
 * shows it ("[14 button]"), when medley numbered its element.
 */
export function auditText(r: AuditResult, labelOf: (ref: number) => string | undefined): string {
  const byRule = new Map<string, Finding[]>();
  for (const f of r.findings) {
    if (!RULES[f.rule]) continue;
    byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  }
  const sum = (level: Rule['level']) => [...byRule].filter(([rule]) => RULES[rule].level === level);
  const problems = sum('problem');
  const warnings = sum('warning');
  const n = (groups: [string, Finding[]][]) => groups.reduce((s, [, f]) => s + f.length, 0);
  const head = `audit: ${count(n(problems), 'problem', 'problems')}${problems.length > 1 ? ` of ${problems.length} kinds` : ''}, ${count(n(warnings), 'warning', 'warnings')} · ${r.title || '(untitled)'} · ${r.url}`;
  const out = [head];

  const section = (title: string, groups: [string, Finding[]][]) => {
    if (!groups.length) return;
    out.push('', title);
    for (const rule of Object.keys(RULES)) {
      const found = byRule.get(rule);
      if (!found || !groups.some(([g]) => g === rule)) continue;
      const { says, wcag, fix } = RULES[rule];
      out.push(`  ${says(found.length)} (WCAG ${wcag})`);
      out.push(...examples(rule, found, labelOf).map((l) => `    ${l}`));
      out.push(`    fix: ${fix}`);
    }
  };
  section('problems (fail WCAG 2.2 A or AA)', problems);
  section('warnings', warnings);

  const c = r.checked;
  out.push(
    '',
    `checked ${count(c.texts, 'piece of text', 'pieces of text')}, ${count(c.controls, 'control', 'controls')}, ${count(c.pictures, 'picture', 'pictures')}, ${count(c.headings, 'heading', 'headings')}` +
      (c.unread ? ` · ${count(c.unread, 'frame', 'frames')} from other sites not checked` : ''),
    'checks like these find some problems, not all: try the page with only a keyboard, and with a screen reader',
  );
  return out.join('\n');
}

function examples(rule: string, found: Finding[], labelOf: (ref: number) => string | undefined): string[] {
  const at = (f: Finding) => {
    const label = f.ref !== undefined ? labelOf(f.ref) : undefined;
    const who = label && f.what ? `${label} · ${f.what}` : (label ?? f.what);
    return f.detail ? `${who} · ${f.detail}` : who;
  };
  // Cases that come many to a kind (a pair of colors, one link text): one line each, with a few of their places.
  if (rule === 'contrast' || rule === 'link-text') {
    const cases = new Map<string, Finding[]>();
    for (const f of found) cases.set(f.key ?? '', [...(cases.get(f.key ?? '') ?? []), f]);
    const lines = [...cases].sort((a, b) => b[1].length - a[1].length).slice(0, EXAMPLES).map(([key, fs]) => {
      const places = fs.slice(0, 3).map((f) => (rule === 'contrast' ? `"${f.what}"` : `${(f.ref !== undefined && labelOf(f.ref)) || f.what} → ${f.detail}`));
      const more = fs.length > 3 ? ` and ${fs.length - 3} more` : '';
      return rule === 'contrast' ? `${key}: ${places.join(', ')}${more}` : `"${key}" ${fs.length}×: ${places.join(', ')}${more}`;
    });
    if (cases.size > EXAMPLES) lines.push(`… and ${cases.size - EXAMPLES} more`);
    return lines;
  }
  const lines = found.filter((f) => f.what || f.ref !== undefined).slice(0, EXAMPLES).map(at);
  if (found.length > EXAMPLES && lines.length) lines.push(`… and ${found.length - EXAMPLES} more`);
  return lines;
}
