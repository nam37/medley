// Runs inside the page (Runtime.evaluate) after scripts have run, and returns a
// compact page model of what is actually rendered:
//   - text nodes become strings (whitespace collapsed unless preformatted)
//   - elements become { tag, d: 'b'|'i' (block/inline), r: [x, y, w, h], c: children }
//   - interactive elements get a numbered ref plus kind, name, value and state
// Hidden content (display:none, visibility:hidden, aria-hidden, closed <details>)
// is dropped. The elements behind the refs are kept in window.__medley so
// later commands can act on them (see page-actions.js).
(() => {
  // A ref stays attached to the same element across snapshots of a document,
  // so diffs between snapshots show only what really changed. `doc` tells a
  // new document (whose numbering starts over) from the one refs came from.
  const M = window.__medley || (window.__medley = {
    doc: Math.random().toString(36).slice(2),
    ids: new WeakMap(),
    els: new Map(),
    next: 1,
  });
  let refCount = 0;
  function refOf(el) {
    let id = M.ids.get(el);
    if (!id) {
      id = M.next++;
      M.ids.set(el, id);
      M.els.set(id, new WeakRef(el));
    }
    refCount++;
    return id;
  }

  let focused = document.activeElement;
  while (focused && focused.shadowRoot && focused.shadowRoot.activeElement) focused = focused.shadowRoot.activeElement;

  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
    'datalist', 'source', 'track', 'param', 'object',
  ]);
  const ROLE_KIND = {
    link: 'link', button: 'button',
    checkbox: 'checkbox', switch: 'checkbox', menuitemcheckbox: 'checkbox',
    radio: 'radio', menuitemradio: 'radio',
    textbox: 'textbox', searchbox: 'textbox', spinbutton: 'textbox',
    combobox: 'combobox', slider: 'slider',
    tab: 'tab', menuitem: 'menuitem', option: 'option',
  };
  const FIELD = new Set(['textbox', 'password', 'combobox', 'select', 'checkbox', 'radio', 'slider', 'file']);
  // Regions (named <section>s) are left out: they nearly always just repeat the heading inside them.
  const ROLE_LANDMARK = {
    banner: 'banner', navigation: 'navigation', main: 'main', complementary: 'complementary',
    contentinfo: 'contentinfo', search: 'search', dialog: 'dialog', alertdialog: 'dialog', form: 'form',
  };
  const TAG_LANDMARK = {
    nav: 'navigation', main: 'main', aside: 'complementary', search: 'search', dialog: 'dialog', form: 'form',
  };

  const clean =(s) => (s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n = 100) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const styleOf = (el) => (el.ownerDocument.defaultView || window).getComputedStyle(el);
  const hostOf = (url) => {
    try { return new URL(url).host; } catch { return ''; }
  };

  /** "rgb(a)(…)" as #rrggbb, or null when (nearly) transparent. */
  // A CSS color as #rrggbb, or null when it's (nearly) transparent. A
  // see-through color is mixed with `under` (#rrggbb), as it shows over it.
  function hex(color, under) {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(color || '');
    const alpha = m && m[4] !== undefined ? +m[4] : 1;
    if (!m || alpha < 0.05) return null;
    let rgb = [+m[1], +m[2], +m[3]];
    if (alpha < 1 && under) {
      const u = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
      rgb = rgb.map((v, i) => Math.round(v * alpha + u[i] * (1 - alpha)));
    }
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // A modal's backdrop: see-through, and fixed over the whole window. It only
  // dims the page behind the modal.
  function backdrop(n, cs) {
    const m = /^rgba\(.*,\s*([\d.]+)\)$/.exec(cs.backgroundColor);
    return !!m && +m[1] < 1 && cs.position === 'fixed' && n.r[2] >= 0.9 * innerWidth && n.r[3] >= 0.9 * innerHeight;
  }

  // How an element looks, for the terminal UI's advanced grid: text color,
  // bold, background, and a border when it has one on every side (a card).
  // These never affect the text rendering.
  function paint(n, cs) {
    const fg = hex(cs.color);
    if (fg) n.fg = fg;
    const bg = backdrop(n, cs) ? null : hex(cs.backgroundColor, canvas);
    if (bg) n.bg = bg;
    if (+cs.fontWeight >= 600) n.fw = 1;
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    if (sides.every((s) => cs[`border${s}Style`] !== 'none' && parseFloat(cs[`border${s}Width`]) >= 1)) {
      const bd = hex(cs.borderTopColor);
      if (bd) n.bd = bd;
    }
  }

  function rectOf(el) {
    const b = el.getBoundingClientRect();
    return [Math.round(b.left + scrollX), Math.round(b.top + scrollY), Math.round(b.width), Math.round(b.height)];
  }

  // Text of an element without the contents of form controls inside it
  // (a <label> wrapping a <select> would otherwise include every option).
  function ownText(el) {
    let s = '';
    for (const c of el.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeType === 1 && !/^(select|textarea|input|button|script|style)$/.test(c.localName)) s += ' ' + ownText(c);
    }
    return s;
  }

  function labelledBy(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return '';
    const root = el.getRootNode();
    return clean(ids.split(/\s+/).map((id) => {
      const t = root.getElementById ? root.getElementById(id) : el.ownerDocument.getElementById(id);
      return t ? t.innerText || t.textContent : '';
    }).join(' '));
  }

  function kindOf(el, tag, role, cs, ctx) {
    if (ROLE_KIND[role]) return ROLE_KIND[role];
    switch (tag) {
      case 'a':
      case 'area':
        if (el.hasAttribute('href')) return 'link';
        break;
      case 'button':
      case 'summary':
        return 'button';
      case 'select':
        return 'select';
      case 'textarea':
        return 'textbox';
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return null;
        if (['button', 'submit', 'reset', 'image', 'color'].includes(t)) return 'button';
        if (t === 'checkbox' || t === 'radio') return t;
        if (t === 'range') return 'slider';
        if (t === 'file') return 'file';
        if (t === 'password') return 'password';
        return 'textbox';
      }
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    // Something made to be dragged (a card on a board, an item to reorder), by
    // its own attribute: links and images are draggable by default, and they're refs already.
    if (!ctx.inRef && el.getAttribute('draggable') === 'true' && clean(el.innerText)) return 'draggable';
    // Script-driven click targets: the outermost element with a pointer cursor
    // that doesn't just wrap a real control.
    if (
      !ctx.inRef && cs.cursor === 'pointer' && ctx.cursor !== 'pointer' &&
      !/^(label|body|html)$/.test(tag) &&
      !el.querySelector('a[href], button, input, select, textarea, [role=button], [role=link]') &&
      clean(el.innerText)
    ) return 'clickable';
    return null;
  }

  function nameOf(el, kind) {
    let s = labelledBy(el) || clean(el.getAttribute('aria-label'));
    if (s) return s;
    const tag = el.localName;
    if (FIELD.has(kind)) {
      if (el.labels && el.labels.length) s = clean([...el.labels].map(ownText).join(' '));
      if (!s && (kind === 'checkbox' || kind === 'radio') && tag !== 'input') s = clean(el.innerText);
      return s || clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '');
    }
    if (tag === 'input') return clean(el.value || el.getAttribute('alt') || el.getAttribute('title') || '') || el.type;
    s = clean(el.innerText) || clean(el.getAttribute('title'));
    if (s) return s;
    for (const d of el.querySelectorAll('img[alt], [aria-label], [title], title')) {
      s = clean(d.getAttribute('alt') || d.getAttribute('aria-label') || d.getAttribute('title') ||
        (d.localName === 'title' ? d.textContent : ''));
      if (s) return s;
    }
    if (kind === 'link') {
      try {
        const u = new URL(el.href);
        return u.pathname.length > 1 ? u.pathname : u.host;
      } catch {}
    }
    return '';
  }

  function valueOf(el, kind) {
    const tag = el.localName;
    if (tag === 'select') return clean([...el.selectedOptions].map((o) => o.text).join(', '));
    if (tag === 'input' || tag === 'textarea') {
      if (!['textbox', 'password', 'combobox', 'slider', 'file'].includes(kind)) return '';
      if (el.type === 'password') return el.value ? '********' : '';
      // A file field's value is a fake path ("C:\fakepath\cv.pdf"); its files' names say more.
      if (el.type === 'file') return [...(el.files || [])].map((f) => f.name).join(', ');
      return el.value;
    }
    if (kind === 'textbox' && el.isContentEditable) return clean(el.innerText);
    if (kind === 'slider' || kind === 'combobox') {
      return clean(el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || '');
    }
    return '';
  }

  function statesOf(el, kind) {
    const s = [];
    const a = (name) => el.getAttribute(name);
    if (kind === 'checkbox' || kind === 'radio') {
      if (el.localName === 'input') s.push(el.checked ? 'checked' : 'unchecked');
      else s.push(a('aria-checked') === 'true' ? 'checked' : a('aria-checked') === 'mixed' ? 'mixed' : 'unchecked');
    }
    if (a('aria-selected') === 'true') s.push('selected');
    if (a('aria-pressed') === 'true') s.push('pressed');
    if (el.localName === 'summary') s.push(el.parentElement && el.parentElement.open ? 'expanded' : 'collapsed');
    else if (a('aria-expanded')) s.push(a('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (a('aria-current') && a('aria-current') !== 'false') s.push('current');
    if (el.disabled || a('aria-disabled') === 'true') s.push('disabled');
    // Focus matters where keystrokes go; on buttons and links it's just churn in diffs.
    if (el === focused && (kind === 'textbox' || kind === 'password' || kind === 'combobox')) s.push('focused');
    return s;
  }

  function landmarkOf(el, tag, role) {
    let lm = ROLE_LANDMARK[role] || (!role && TAG_LANDMARK[tag]);
    if (!lm && !role && (tag === 'header' || tag === 'footer')) {
      const scoped = el.parentElement && el.parentElement.closest('article, aside, main, nav, section, [role=main], [role=article]');
      if (!scoped) lm = tag === 'header' ? 'banner' : 'contentinfo';
    }
    if (!lm) return null;
    const name = cut(labelledBy(el) || clean(el.getAttribute('aria-label')), 60);
    if (lm === 'form' && !name) return null;
    return [lm, name];
  }

  function isDataTable(el, role) {
    if (role === 'presentation' || role === 'none') return false;
    if (role === 'table' || role === 'grid') return true;
    if (el.querySelector('table')) return false; // nested tables mean layout
    if (el.tHead || el.caption) return true;
    return [...el.rows].some((r) => [...r.cells].some((c) => c.localName === 'th'));
  }

  function preText(t) {
    const out = [];
    t.replace(/\t/g, '    ').split('\n').forEach((line, i) => {
      if (i) out.push({ tag: 'br', d: 'i' });
      if (line) out.push(line);
    });
    return out;
  }

  // Text of a <pre>, with line breaks where the browser draws them. innerText gets
  // editor-style markup wrong: highlighters wrap each line in a block that ends
  // in <br>, which renders as one break but innerText counts as two.
  function preTextOf(el) {
    let s = '';
    const visit = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) s += c.data;
        else if (c.nodeType !== 1) continue;
        else if (c.localName === 'br') s += '\n';
        else {
          const display = styleOf(c).display;
          if (display === 'none') continue;
          const block = !/^(inline|contents|ruby)/.test(display);
          if (block && s && !s.endsWith('\n')) s += '\n';
          visit(c);
          if (block && !s.endsWith('\n')) s += '\n';
        }
      }
    };
    visit(el);
    return s.replace(/\t/g, '    ');
  }

  // Some pages mark a modal's wrapper aria-hidden by mistake (cnn.com's consent
  // dialog). The modal still covers the page and has to be answered, so keep it.
  const DIALOG = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]';
  function holdsDialog(el) {
    for (const d of el.querySelectorAll(DIALOG)) {
      if (d.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return true;
    }
    return false;
  }

  // Whether an element floats over the page: a modal <dialog>, or anything fixed in place.
  const overlays = [];
  function floats(el) {
    try {
      if (el.matches(':modal')) return true;
    } catch {}
    for (let a = el; a; a = a.parentElement || a.getRootNode().host) {
      if (styleOf(a).position === 'fixed') return true;
    }
    return false;
  }

  function childNodesOf(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.localName === 'slot') {
      const assigned = el.assignedNodes({ flatten: true });
      return assigned.length ? assigned : el.childNodes;
    }
    return el.childNodes;
  }

  function kids(el, ctx) {
    const out = [];
    for (const c of childNodesOf(el)) {
      const r = walk(c, ctx);
      if (r == null) continue;
      for (const x of Array.isArray(r) ? r : [r]) {
        if (typeof x === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += x;
        else out.push(x);
      }
    }
    return out;
  }

  function walk(node, ctx) {
    if (node.nodeType === 3) {
      if (!ctx.vis || ctx.noText) return null;
      if (ctx.pre) return preText(node.data);
      return node.data.replace(/\s+/g, ' ') || null;
    }
    if (node.nodeType !== 1) return null;

    const el = node;
    const tag = el.localName;
    if (SKIP.has(tag) || (el.getAttribute('aria-hidden') === 'true' && !holdsDialog(el))) return null;
    const cs = styleOf(el);
    if (cs.display === 'none') return null;
    // Catches content-visibility:hidden too (closed <details>, hidden=until-found).
    // display:contents has no box, so checkVisibility() is always false for it.
    if (cs.display !== 'contents' && el.checkVisibility && !el.checkVisibility()) return null;

    const vis = cs.visibility === 'visible';
    const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    const r = rectOf(el);
    // Absolute positioning blockifies, but a 1px clipped box is screen-reader-only
    // text that belongs in the flow of the sentence around it.
    const srOnly = /^(absolute|fixed)$/.test(cs.position) && (r[2] <= 1 || r[3] <= 1);
    const inline = /^(inline|ruby)/.test(cs.display) || cs.display === 'contents' || srOnly;
    const n = { tag, d: inline ? 'i' : 'b' };
    if (!inline) {
      n.r = r;
      paint(n, cs);
    }
    if (/^inline-(block|flex|grid)$/.test(cs.display)) n.box = 1;
    const inner = { vis, pre: ctx.pre, cursor: cs.cursor, inRef: ctx.inRef, noText: ctx.noText };

    if (tag === 'br') return vis ? n : null;

    if (tag === 'img' || role === 'img') {
      const alt = cut(clean(tag === 'img' ? el.getAttribute('alt') : nameOf(el, 'img')), 120);
      if (!vis || !alt) return null;
      n.tag = 'img';
      n.alt = alt;
      return n;
    }
    if (tag === 'svg' || tag === 'math') return null;

    if (tag === 'iframe' || tag === 'frame') {
      let doc = null;
      try { doc = el.contentDocument; } catch {}
      if (doc && doc.body) {
        n.c = kids(doc.body, inner);
        return n.c.length ? n : null;
      }
      if (!vis || r[2] < 50 || r[3] < 50) return null;
      n.tag = 'iframe';
      n.n = cut(clean(el.title || el.getAttribute('aria-label') || el.name || ''), 80) || hostOf(el.src);
      // Set by medley (in this world only) on the frame's element, so its
      // content can be read separately and put in here.
      if (typeof el.__medleyFrame === 'string') n.frame = el.__medleyFrame;
      return n;
    }

    if (tag === 'video' || tag === 'audio' || tag === 'canvas' || tag === 'embed') {
      if (!vis || (tag !== 'audio' && (r[2] < 50 || r[3] < 30))) return null;
      n.tag = 'embed';
      n.kind = tag;
      n.n = cut(clean(el.getAttribute('aria-label') || el.title || ''), 80);
      return n;
    }

    if (tag === 'pre' && !inline) {
      n.txt = preTextOf(el).replace(/\s+$/, '');
      return n.txt ? n : null;
    }

    if (tag === 'table' && isDataTable(el, role)) {
      n.rows = [];
      for (const row of el.rows) {
        if (styleOf(row).display === 'none') continue;
        const cells = [];
        for (const cell of row.cells) {
          if (styleOf(cell).display === 'none') continue;
          cells.push({ th: cell.localName === 'th' ? 1 : 0, c: kids(cell, inner) });
        }
        if (cells.length) n.rows.push(cells);
      }
      if (el.caption) n.cap = cut(clean(el.caption.innerText), 120);
      return n.rows.length ? n : null;
    }

    const kind = vis ? kindOf(el, tag, role, cs, ctx) : null;
    if (kind) {
      n.ref = refOf(el);
      n.k = kind;
      if (inline) paint(n, cs); // so a button can keep its colors
      if (kind === 'link') n.href = typeof el.href === 'string' ? el.href : el.getAttribute('href');
      const v = valueOf(el, kind);
      if (v) n.v = cut(v, 80);
      const s = statesOf(el, kind);
      if (s.length) n.s = s;
      // A link or click target wrapping a whole card keeps its structure;
      // anything else is atomic and represented by its name.
      if ((kind === 'link' || kind === 'clickable') && /\n/.test((el.innerText || '').trim())) {
        n.c = kids(el, { ...inner, inRef: true });
      } else {
        n.n = cut(nameOf(el, kind));
      }
      return n;
    }

    const h = /^h[1-6]$/.test(tag) ? +tag[1] : role === 'heading' ? +el.getAttribute('aria-level') || 2 : 0;
    if (h) n.h = h;
    const lm = landmarkOf(el, tag, role);
    if (lm) {
      n.lm = lm[0];
      if (lm[1]) n.lmn = lm[1];
    }
    // A dialog floating over the page (a modal, a consent notice) gets drawn
    // over it in the terminal UI's advanced grid, not in among what it covers.
    if (!inline && el.matches(DIALOG) && floats(el)) n.ov = `${M.doc}:${overlays.push(el)}`;
    if (/^(ul|ol|menu)$/.test(tag) || role === 'list') {
      n.list = tag === 'ol' ? 'ol' : 'ul';
      if (tag === 'ol' && el.start !== 1) n.start = el.start;
    }
    if (tag === 'li' || role === 'listitem') {
      n.li = 1;
      if (!n.r) n.r = rectOf(el);
    }
    if (tag === 'blockquote') n.bq = 1;

    // A label's text already names its control's ref, so don't repeat it
    // (unless the control itself isn't rendered, e.g. a hidden custom checkbox).
    const control = tag === 'label' && el.control;
    if (control && control.checkVisibility() && styleOf(control).visibility === 'visible') inner.noText = true;

    const pre = ctx.pre || /^(pre|break-spaces)/.test(cs.whiteSpace) || /^(preserve|break-spaces)/.test(cs.whiteSpaceCollapse || '');
    n.c = kids(el, { ...inner, pre });
    if (!n.c.some((c) => typeof c !== 'string' || c.trim())) return inline && n.c.length ? ' ' : null;
    return n;
  }

  // The page's own background: the body's, the root's, or the browser default.
  const canvas = hex(getComputedStyle(document.body || document.documentElement).backgroundColor) ||
    hex(getComputedStyle(document.documentElement).backgroundColor) || '#ffffff';

  const root = document.body ? walk(document.body, { vis: true, pre: false, cursor: '', inRef: false, noText: false }) : null;

  // Every visible picture, labelled or not, with where it is. Kept apart from
  // the tree so the text rendering can't change; the terminal UI draws them.
  const pics = [];
  for (const img of document.querySelectorAll('img, video, canvas, svg[role=img]')) {
    const r = rectOf(img);
    if (r[2] < 24 || r[3] < 24 || !img.checkVisibility({ visibilityProperty: true })) continue;
    const pic = { r, alt: clean(img.getAttribute('alt') || img.getAttribute('aria-label') || '') };
    const ov = overlays.findLastIndex((o) => o.contains(img)); // the innermost floating dialog it's in
    if (ov >= 0) pic.ov = `${M.doc}:${ov + 1}`;
    pics.push(pic);
    if (pics.length >= 200) break;
  }
  return {
    doc: M.doc,
    url: location.href,
    title: document.title,
    refs: refCount,
    vw: innerWidth,
    vh: innerHeight,
    dh: document.documentElement.scrollHeight,
    sy: Math.round(scrollY),
    bg: canvas,
    fg: hex(getComputedStyle(document.body || document.documentElement).color) || '#000000',
    pics,
    root: root && typeof root === 'object' ? root : null,
  };
})()
