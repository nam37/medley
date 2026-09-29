// Runs inside the page, after extract.js (whose refs it names), and looks for
// the accessibility problems that can be found by looking at a page: pictures
// without text, controls without names, text without enough contrast, things
// only a mouse can use, headings that skip levels, and a few page-wide ones.
// It returns what it found; audit.ts says it in words.
(() => {
  const M = window.__medley;
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

  const findings = [];
  const add = (rule, el, extra = {}) => {
    const ref = el && M && M.ids.get(el);
    findings.push({ rule, ...(ref ? { ref } : {}), what: el ? describe(el) : '', ...extra });
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

  // ---- everything on the page, open shadow roots included ------------------------

  const all = [];
  (function collect(root) {
    for (const el of root.querySelectorAll('*')) {
      if (all.length >= 30000) return;
      all.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  })(document);

  const checked = { texts: 0, controls: 0, pictures: 0, headings: 0, frames: 0, unread: 0 };

  // ---- the page as a whole -------------------------------------------------------

  if (!clean(document.documentElement.getAttribute('lang'))) add('lang', null);
  if (!clean(document.title)) add('title', null);
  const viewport = document.querySelector('meta[name="viewport"]');
  const vp = viewport ? viewport.getAttribute('content') || '' : '';
  const maxScale = /maximum-scale\s*=\s*([\d.]+)/i.exec(vp);
  if (/user-scalable\s*=\s*(no|0)\b/i.test(vp) || (maxScale && +maxScale[1] < 2)) add('zoom', null, { what: `<meta name="viewport" content="${cut(vp, 80)}">` });
  if (!document.querySelector('main, [role="main"]')) add('main', null);

  // ---- controls: names, labels, and the keyboard ---------------------------------

  const INTERACTIVE = new Set([
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'listbox',
  ]);
  const NATIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]';
  const FOCUSABLE = `${NATIVE}, [tabindex]`;
  const COMPOSITE = '[role="menu"], [role="menubar"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="tree"], [role="grid"], [role="treegrid"]';
  const VAGUE = /^(click here|here|read more|more|learn more|link|this|go|details|continue( reading)?|more info(rmation)?|see more|view more|find out more)$/i;

  function isControl(el) {
    const role = roleOf(el);
    if (INTERACTIVE.has(role)) return true;
    const tag = el.localName;
    if (tag === 'a') return el.hasAttribute('href');
    if (/^(button|select|textarea|summary)$/.test(tag)) return true;
    return tag === 'input' && el.type !== 'hidden';
  }

  for (const el of all) {
    if (!isControl(el) || !shown(el) || unexposed(el)) continue;
    checked.controls++;
    const [name, from] = accName(el);
    if (!name) add('name', el);
    else if (from === 'placeholder') add('placeholder', el);
    if (el.localName === 'a' && VAGUE.test(name)) add('link-text', el, { key: name, detail: cut(el.getAttribute('href') || '', 50) });
    // A widget made of a div needs to be focusable (in a menu or a tab list, one item at a time is).
    const role = roleOf(el);
    if (INTERACTIVE.has(role) && !el.matches(NATIVE) && el.tabIndex < 0 && !el.closest(COMPOSITE)) add('keyboard', el);
  }

  // What medley took for clickable by its pointer cursor: a div with a click handler, most likely.
  if (M) {
    for (const [, weak] of M.els) {
      const el = weak.deref();
      if (!el || !el.isConnected || el.matches(NATIVE) || roleOf(el) || !shown(el) || unexposed(el)) continue;
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      add(el.tabIndex < 0 ? 'keyboard' : 'role', el);
    }
  }

  // Focusable, but hidden from screen readers: a keyboard lands on something that says nothing.
  for (const el of all) {
    if (el.getAttribute('aria-hidden') !== 'true' || !shown(el)) continue;
    if (parentOf(el) && parentOf(el).closest('[aria-hidden="true"]')) continue; // the outermost says it
    const inside = [el, ...el.querySelectorAll(FOCUSABLE)].filter(
      (f) => f.matches(FOCUSABLE) && f.tabIndex >= 0 && !f.disabled && !f.closest('[inert]') && shown(f),
    );
    if (inside.length) add('hidden-focus', inside[0], inside.length > 1 ? { detail: `and ${inside.length - 1} more in it` } : {});
  }

  for (const el of all) {
    if (el.tabIndex > 0 && el.hasAttribute('tabindex') && shown(el)) add('tabindex', el, { detail: `tabindex="${el.getAttribute('tabindex')}"` });
  }

  // ---- pictures, frames, media ---------------------------------------------------

  const FILE_NAME = /^\S+\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?)$|^(img|image|dsc|photo|pic|screenshot)[-_ ]?\d+$/i;
  for (const el of all) {
    const tag = el.localName;
    const role = roleOf(el);
    if (tag === 'img') {
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue; // a tracking pixel
      checked.pictures++;
      if (unexposed(el) || role === 'presentation' || role === 'none') continue;
      const alt = el.getAttribute('alt');
      if (alt === null && !accName(el)[0]) add('alt', el);
      else if (alt && FILE_NAME.test(alt.trim())) add('alt-file', el, { detail: `alt="${cut(alt.trim(), 40)}"` });
    } else if (role === 'img') {
      if (!shown(el) || unexposed(el)) continue;
      checked.pictures++;
      if (!accName(el)[0]) add('alt', el);
    } else if (tag === 'iframe') {
      if (!shown(el) || unexposed(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) continue;
      checked.frames++;
      let readable = false;
      try { readable = !!el.contentDocument; } catch {}
      if (!readable) checked.unread++;
      if (!clean(el.getAttribute('title')) && !accName(el)[0]) add('frame-title', el);
    } else if ((tag === 'video' || tag === 'audio') && el.autoplay && !el.muted && shown(el)) {
      add('autoplay', el);
    }
  }

  // ---- headings ------------------------------------------------------------------

  let prev = null;
  let hasH1 = false;
  for (const el of all) {
    const level = /^h[1-6]$/.test(el.localName) ? +el.localName[1] : roleOf(el) === 'heading' ? +el.getAttribute('aria-level') || 2 : 0;
    if (!level || !shown(el) || unexposed(el)) continue;
    checked.headings++;
    const text = cut(clean(el.textContent), 40);
    if (level === 1) hasH1 = true;
    if (prev && level > prev.level + 1) add('headings', el, { what: `h${prev.level} "${prev.text}" → h${level} "${text}"` });
    prev = { level, text };
  }
  if (checked.headings && !hasH1) add('no-h1', null);

  // ---- contrast --------------------------------------------------------------------

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

  // Pictures and gradients text might sit on, found once.
  const pictures = [];
  for (const el of all) {
    if (pictures.length >= 400) break;
    const picture = /^(img|video|canvas|svg|picture)$/.test(el.localName) || getComputedStyle(el).backgroundImage !== 'none';
    if (!picture || !el.checkVisibility()) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 16 && r.height >= 16) pictures.push({ el, r });
  }
  const overPicture = (t, el) =>
    pictures.some(({ el: p, r }) => {
      if (p.contains(el)) return false; // behind it as a background: see backdrop
      const w = Math.min(t.right, r.right) - Math.max(t.left, r.left);
      const h = Math.min(t.bottom, r.bottom) - Math.max(t.top, r.top);
      return w > 0 && h > 0 && w * h >= 0.3 * t.width * t.height;
    });

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

  const seen = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && checked.texts < 5000) {
    const node = walker.currentNode;
    const text = clean(node.data);
    if (!/[\p{L}\p{N}]/u.test(text)) continue; // separators and symbols
    const el = node.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.closest('script, style, noscript, template, select, textarea, svg, [aria-hidden="true"]')) continue;
    if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const t = range.getBoundingClientRect();
    if (t.width < 2 || t.height < 2) continue; // clipped away: text for screen readers
    checked.texts++;
    if (el.closest(':disabled, [aria-disabled="true"]')) continue; // disabled controls are exempt
    const cs = getComputedStyle(el);
    const fg = rgba(cs.color);
    if (!fg || fg[3] < 0.1 || cs.textShadow !== 'none') continue;
    const back = backdrop(el);
    if (!back || overPicture(t, el)) continue;
    let seenColor = over(fg, back.color);
    if (back.opacity < 1) seenColor = over([...seenColor.slice(0, 3), back.opacity], back.color);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && +cs.fontWeight >= 700);
    const need = large ? 3 : 4.5;
    const ratio = contrast(seenColor, back.color);
    if (ratio + 0.005 >= need) continue;
    findings.push({
      rule: 'contrast',
      what: cut(text, 40),
      key: `${hex(seenColor)} on ${hex(back.color)} is ${Math.floor(ratio * 10) / 10}:1, needs ${need}:1${large ? ' (large text)' : ''}`,
    });
  }

  return { url: location.href, title: document.title, findings, checked };
})()
