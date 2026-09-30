// Page-side helpers shared by audit.js and inspect.js: what an element is
// called (its accessible name, and where that comes from), how a developer
// would point at it, and the colors it's seen in. The file is one expression,
// an object of functions; the session hands it to those scripts as LIB.
(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const roleOf = (el) => (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
  const parentOf = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const shown = (el) => el.checkVisibility({ visibilityProperty: true });
  // Left out of what a screen reader reads (and so needing no name).
  const unexposed = (el) => !!el.closest('[aria-hidden="true"], [inert]');
  const hostOf = (url) => {
    try { return new URL(url).host; } catch { return ''; }
  };

  function fileOf(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return 'a data: address';
    try {
      const u = new URL(url, location.href);
      return cut(decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.host), 40);
    } catch {
      return cut(url, 40);
    }
  }

  /** An element as a developer finds it: tag, id or class, and its text, size or address. */
  function describe(el) {
    const r = el.getBoundingClientRect();
    const size = `${Math.round(r.width)}×${Math.round(r.height)}`;
    const tag = el.localName;
    if (tag === 'img') return `img ${fileOf(el.currentSrc || el.getAttribute('src'))} ${size}`.replace('  ', ' ');
    if (tag === 'iframe') return `iframe ${hostOf(el.src) || fileOf(el.getAttribute('src')) || '(blank)'} ${size}`;
    let s = tag;
    if (el.id) s += `#${cut(el.id, 30)}`;
    else if (typeof el.className === 'string' && el.className.trim()) s += `.${cut(el.className.trim().split(/\s+/)[0], 30)}`;
    if (/^(svg|video|canvas|audio)$/.test(tag)) return `${s} ${size}`;
    const text = cut(clean(el.innerText || el.textContent || ''), 40);
    if (text) s += ` "${text}"`;
    const href = tag === 'a' && el.getAttribute('href');
    if (href) s += ` → ${cut(href, 50)}`;
    return s;
  }

  // ---- accessible names, as browsers work them out (the common cases) ----------

  function labelledBy(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return '';
    const root = el.getRootNode();
    return clean(ids.split(/\s+/).map((id) => {
      const t = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      return t ? t.textContent : '';
    }).join(' '));
  }

  // CSS content (::before { content: "Menu" }, a counter, an attribute) counts;
  // an icon font's private-use character doesn't.
  function pseudo(el, which) {
    const c = getComputedStyle(el, which).content;
    if (!c || c === 'none' || c === 'normal') return '';
    let text = [...c.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('');
    for (const m of c.matchAll(/attr\(\s*([\w-]+)\s*\)/g)) text += el.getAttribute(m[1]) || '';
    if (/counters?\(/.test(c)) text += '#'; // a number, whichever it is
    return /[-]/.test(text) ? '' : text;
  }

  function childrenOf(node) {
    if (node.shadowRoot) return node.shadowRoot.childNodes;
    if (node.localName === 'slot') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return node.childNodes;
  }

  function textOf(node) {
    let s = '';
    for (const c of childrenOf(node)) {
      if (c.nodeType === 3) {
        s += c.data;
        continue;
      }
      if (c.nodeType !== 1 || c.getAttribute('aria-hidden') === 'true') continue;
      const tag = c.localName;
      if (/^(script|style|noscript|template|select|textarea)$/.test(tag) || (tag === 'input' && c.type !== 'image')) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const own = labelledBy(c) || clean(c.getAttribute('aria-label'));
      if (own) s += ` ${own} `;
      else if (tag === 'img' || tag === 'input') s += ` ${c.getAttribute('alt') || ''} `;
      else if (tag === 'svg') s += ` ${(c.querySelector('title') || {}).textContent || ''} `;
      else {
        // What's in it, or else its tooltip (an icon with title="upvote").
        const inner = `${pseudo(c, '::before')}${textOf(c)}${pseudo(c, '::after')}`;
        s += ` ${clean(inner) ? inner : c.getAttribute('title') || ''} `;
      }
    }
    return s;
  }

  const CONTENT_ROLES = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio',
    'switch', 'treeitem', 'heading', 'cell', 'columnheader', 'rowheader', 'tooltip',
  ]);

  /** An element's accessible name, and where it came from ('' when it has none). */
  function accName(el) {
    const by = labelledBy(el);
    if (by) return [by, 'labelledby'];
    const label = clean(el.getAttribute('aria-label'));
    if (label) return [label, 'aria-label'];
    const tag = el.localName;
    if (/^(input|select|textarea)$/.test(tag)) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && /^(submit|reset|button)$/.test(type)) {
        const v = clean(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
        if (v) return [v, 'value'];
      }
      if (tag === 'input' && type === 'image') {
        const alt = clean(el.getAttribute('alt'));
        if (alt) return [alt, 'alt'];
      }
      if (el.labels && el.labels.length) {
        const text = clean([...el.labels].map((l) => textOf(l)).join(' '));
        if (text) return [text, 'label'];
      }
      const title = clean(el.getAttribute('title'));
      if (title) return [title, 'title'];
      const placeholder = clean(el.getAttribute('placeholder'));
      if (placeholder) return [placeholder, 'placeholder'];
      return ['', ''];
    }
    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      if (alt !== null) return [clean(alt), 'alt'];
    }
    const role = roleOf(el);
    if (role ? CONTENT_ROLES.has(role) : /^(a|button|summary|h[1-6])$/.test(tag)) {
      const text = clean(`${pseudo(el, '::before')}${textOf(el)}${pseudo(el, '::after')}`);
      if (text) return [text, 'content'];
    }
    if (tag === 'svg') {
      const t = el.querySelector('title');
      if (t && clean(t.textContent)) return [clean(t.textContent), 'title'];
    }
    const title = clean(el.getAttribute('title'));
    return title ? [title, 'title'] : ['', ''];
  }

  // ---- colors ---------------------------------------------------------------------

  function rgba(color) {
    const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color || '');
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
  const luminance = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // The solid color behind an element, and how see-through the element is
  // over it; null when that can't be told (a picture, a gradient, a filter).
  function backdrop(el) {
    const layers = [];
    let opacity = 1;
    for (let a = el; a; a = parentOf(a)) {
      const cs = getComputedStyle(a);
      if (cs.backgroundImage !== 'none' || cs.filter !== 'none' || cs.mixBlendMode !== 'normal') return null;
      const bg = rgba(cs.backgroundColor);
      if (!bg) return null; // a color it can't read (oklch, display-p3)
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
      opacity *= +cs.opacity;
    }
    let color = [255, 255, 255, 1]; // the browser's own background
    for (const layer of layers.reverse()) color = over(layer, color);
    return { color, opacity };
  }

  return {
    clean, cut, roleOf, parentOf, shown, unexposed, hostOf, fileOf, describe,
    labelledBy, pseudo, textOf, accName, rgba, over, luminance, contrast, hex, backdrop,
  };
})()
