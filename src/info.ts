// Page info, as a browser's padlock menu or Lynx's = shows it: the connection
// and its certificate, the cookies and data sites keep, what the page is, and
// what loading it took. Session.info gathers it; infoText words it for every
// client (the CLI, agents, the terminal UI).

import type { DocumentResponse } from './browser.ts';

export interface PageInfo {
  url: string;
  title: string;
  site: string; // the page's site (its registrable domain, roughly), or '' for files and such
  connection: {
    scheme: string; // https:, http:, file:, …
    response: Omit<DocumentResponse, 'requestId'> | null;
  };
  cookies: { site: number; others: { site: string; count: number }[] } | null;
  storage: { usage: number; parts: { type: string; usage: number }[] } | null;
  about: About;
  problems: {
    heard: boolean; // whether the console is being listened to (see Page.watchConsole)
    errors: string[]; // console errors, oldest first
    warnings: number;
    failed: string[]; // failed requests: "404 GET https://…"
  };
}

/** What the page says about itself, read in the page by ABOUT. */
export interface About {
  lang: string;
  description: string;
  author: string;
  published: string;
  modified: string;
  canonical: string;
  words: number;
  links: number;
  forms: number;
  fields: number;
  pictures: number;
  frames: number;
  parsed: number; // ms from the navigation's start; 0 when not yet
  loaded: number;
  since: number; // ms since the navigation started
  requests: number;
  bytes: number; // transferred, as far as the page can tell (other sites often don't say)
  hosts: string[]; // the hosts it asked for things, most asked first
}

/** Read in the page (medley's world): what it says about itself, and what loading it took. */
export const ABOUT = `(() => {
  const meta = (sel) => (document.querySelector(sel)?.getAttribute('content') || '').trim();
  // Structured data (JSON-LD): where news sites and shops say who wrote a page, and when.
  const ld = {};
  const visit = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(visit);
    if (x['@graph']) visit(x['@graph']);
    if (!ld.published && typeof x.datePublished === 'string') ld.published = x.datePublished;
    if (!ld.modified && typeof x.dateModified === 'string') ld.modified = x.dateModified;
    if (!ld.author && x.author) {
      ld.author = [].concat(x.author).map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean).join(', ');
    }
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(s.textContent)); } catch {}
  }
  const nav = performance.getEntriesByType('navigation')[0];
  const resources = performance.getEntriesByType('resource');
  const hosts = new Map();
  let bytes = nav ? nav.transferSize : 0;
  for (const r of resources) {
    try { const h = new URL(r.name).host; if (h) hosts.set(h, (hosts.get(h) || 0) + 1); } catch {}
    bytes += r.transferSize || 0;
  }
  // Without a Last-Modified header, lastModified is just now.
  const lastModified = Date.parse(document.lastModified);
  const text = document.body ? document.body.innerText : '';
  return {
    lang: document.documentElement.lang || '',
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    author: meta('meta[name="author"]') || ld.author || '',
    published: meta('meta[property="article:published_time"]') || ld.published ||
      (document.querySelector('[itemprop="datePublished"]')?.getAttribute('content') || ''),
    modified: meta('meta[property="article:modified_time"]') || ld.modified ||
      (lastModified && Math.abs(Date.now() - lastModified) > 60000 ? new Date(lastModified).toISOString() : ''),
    canonical: document.querySelector('link[rel="canonical"]')?.href || '',
    words: (text.match(/\\S+/g) || []).length,
    links: document.links.length,
    forms: document.forms.length,
    fields: document.querySelectorAll('input:not([type=hidden]), select, textarea').length,
    pictures: [...document.images].filter((i) => i.width >= 24 && i.height >= 24).length,
    frames: window.frames.length,
    parsed: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
    loaded: nav ? Math.round(nav.loadEventEnd) : 0,
    since: Math.round(performance.now()),
    requests: resources.length + 1,
    bytes,
    hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h),
  };
})()`;

/**
 * A host's site: its registrable domain, roughly (the last two labels, or
 * three under a country's second level, as in bbc.co.uk). IP addresses and
 * single names stay whole.
 */
export function siteOf(host: string): string {
  const name = host.replace(/^\./, '').replace(/:\d+$/, '').toLowerCase();
  const parts = name.split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1]) || name.startsWith('[')) return name;
  const tld = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  return parts.slice(tld.length === 2 && second.length <= 3 ? -3 : -2).join('.');
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1e6) return `${Math.round(bytes / 1000)} kB`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function when(text: string): string {
  const t = Date.parse(text);
  return Number.isNaN(t) ? text : new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function language(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A list of names, the first few of them. */
function some(names: string[], max = 5): string {
  return names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');
}

/** The page info as sections of indented lines: Connection, Cookies and site data, About this page, Loading. */
export function infoText(info: PageInfo): string {
  const out: string[] = [];
  const r = info.connection.response;
  const s = r?.security;

  out.push('Connection');
  // CDP says h2, h3, http/1.1.
  const http = r?.protocol && r.protocol !== 'file' ? r.protocol.toUpperCase().replace(/^H(\d)$/, 'HTTP/$1') : '';
  const via = [http, r?.remoteAddress ? `from ${r.remoteAddress}` : ''].filter(Boolean).join(' ');
  if (info.connection.scheme === 'https:' && s) {
    const insecure = r?.securityState === 'insecure';
    out.push(`  ${insecure ? 'Not secure: the certificate has a problem' : 'Secure'}: ${s.protocol} (${[s.keyExchange, s.cipher].filter(Boolean).join(', ')})${via ? ` over ${via}` : ''}`);
    // A certificate names many sites; say the one this page is.
    const host = new URL(info.url).hostname;
    const name = s.sans.find((n) => n === host) ?? s.sans.find((n) => n.startsWith('*.') && host.endsWith(n.slice(1))) ?? s.subject;
    const names = s.sans.length > 1 ? ` (and ${plural(s.sans.length - 1, 'other name')})` : '';
    out.push(`  Certificate for ${name}${names}, issued by ${s.issuer}, valid ${day(s.validFrom)} to ${day(s.validTo)}`);
  } else if (info.connection.scheme === 'https:') {
    out.push(`  Secure (https)${via ? ` over ${via}` : ''}${r?.fromCache ? ', from the cache' : ''}`);
  } else if (info.connection.scheme === 'http:') {
    out.push(`  Not secure: plain http, which anyone on the way can read or change${via ? ` · ${via}` : ''}`);
  } else if (info.connection.scheme === 'file:') {
    out.push('  A file on this computer');
  } else if (info.connection.scheme === 'chrome-error:') {
    out.push("  The page didn't load: this is the browser's error page");
  } else {
    out.push(`  Not from a server (${info.connection.scheme.replace(/:$/, '')})`);
  }

  if (info.cookies || info.storage) {
    out.push('Cookies and site data');
    if (info.cookies) {
      const others = info.cookies.others;
      const theirs = others.reduce((n, o) => n + o.count, 0);
      const mine = plural(info.cookies.site, 'cookie') + (info.site ? ` from ${info.site}` : '');
      out.push(`  ${mine}${theirs ? `; ${theirs} from ${plural(others.length, 'other site')}: ${some(others.map((o) => `${o.site} ${o.count}`))}` : ''}`);
    }
    if (info.storage) {
      const parts = info.storage.parts.filter((p) => p.usage > 0).map((p) => `${p.type.replace(/_/g, ' ')} ${size(p.usage)}`);
      out.push(`  ${info.storage.usage ? `${size(info.storage.usage)} stored${parts.length ? `: ${parts.join(', ')}` : ''}` : 'Nothing stored'}`);
    }
  }

  const a = info.about;
  out.push('About this page');
  out.push(`  ${info.title || '(untitled)'}`);
  out.push(`  ${info.url}`);
  if (a.canonical && a.canonical !== info.url) out.push(`  Its own address for itself: ${a.canonical}`);
  if (a.description) out.push(`  "${a.description.length > 200 ? a.description.slice(0, 199) + '…' : a.description}"`);
  const facts = [
    a.lang ? language(a.lang) : '',
    a.author ? `by ${a.author}` : '',
    a.published ? `published ${when(a.published)}` : '',
    a.modified && a.modified !== a.published ? `updated ${when(a.modified)}` : '',
  ].filter(Boolean);
  if (facts.length) out.push(`  ${facts.join(' · ')}`);
  out.push(`  ${plural(a.words, 'word')}${a.words >= 200 ? `, about ${plural(Math.max(1, Math.round(a.words / 230)), 'minute')} to read` : ''}`);
  const fields = a.fields ? `${plural(a.fields, 'field')}${a.forms ? ` in ${plural(a.forms, 'form')}` : ''}` : '';
  out.push(`  ${[plural(a.links, 'link'), fields, plural(a.pictures, 'picture'), a.frames ? plural(a.frames, 'frame') : ''].filter(Boolean).join(' · ')}`);

  const p = info.problems;
  out.push('Problems');
  if (!p.heard) out.push("  The console isn't being listened to on this page yet (medley console turns it on)");
  else if (p.errors.length) {
    out.push(`  ${plural(p.errors.length, 'console error')}${p.warnings ? ` and ${plural(p.warnings, 'warning')}` : ''}: ${some(p.errors.map((e) => (e.length > 100 ? e.slice(0, 99) + '…' : e)), 3)}`);
  } else out.push(`  No console errors${p.warnings ? `, ${plural(p.warnings, 'warning')}` : ''}`);
  out.push(p.failed.length ? `  ${plural(p.failed.length, 'failed request')}: ${some(p.failed.map((f) => (f.length > 100 ? f.slice(0, 99) + '…' : f)), 3)}` : '  No failed requests');

  out.push('Loading');
  // HTTP/2 and 3 send no status text.
  const reason = r?.statusText || (r?.status === 200 ? 'OK' : '');
  const status = r ? `${r.status} ${reason}`.trim() + (r.mimeType ? `, ${r.mimeType}` : '') : '';
  const times = [a.parsed ? `parsed in ${seconds(a.parsed)}` : '', a.loaded ? `loaded in ${seconds(a.loaded)}` : `still loading after ${seconds(a.since)}`];
  out.push(`  ${[status, ...times].filter(Boolean).join(' · ')}`);
  const others = info.site ? [...new Set(a.hosts.map(siteOf))].filter((x) => x !== info.site) : [];
  const hosts = a.hosts.length ? ` to ${plural(a.hosts.length, 'host')}${others.length ? ` (${plural(others.length, 'other site')})` : ''}` : '';
  out.push(`  ${plural(a.requests, 'request')}${hosts} · at least ${size(a.bytes)} transferred`);
  if (others.length) out.push(`  Other sites it asked: ${some(others, 8)}`);
  return out.join('\n');
}
