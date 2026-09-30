// Runs inside the page, after extract.js (whose refs it's asked about): what
// a developer would look up about one element in the browser's own tools. Its
// markup and where it sits in the document, what it's called and why, its box,
// whether it can be seen and why not, and the styles that make it look the way
// it does. It returns what it found; inspect.ts says it in words. What a page's
// script can't see (event listeners, the CSS rules behind the styles) the
// session asks the browser for (see Page.listenersOf, Page.rulesOf).
// LIB is page-lib.js, handed in by the session; the file is a function of the
// ref and any extra CSS properties to read.
((ref, extra) => {
  const M = window.__medley;
  const el = M && M.els.has(ref) ? M.els.get(ref).deref() : null;
  if (!el || !el.isConnected) return { error: `ref ${ref} isn't on the page; take a new snapshot for current refs` };
  const { clean, cut, roleOf, parentOf, describe, accName, rgba, over, contrast, hex, backdrop } = LIB;
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const cs = view.getComputedStyle(el);
  const tag = el.localName;
  const px = (v) => Math.round(parseFloat(v) * 10) / 10;

  // ---- markup -----------------------------------------------------------------------

  // What's typed into a password never leaves the page, even as markup.
  const secret = (node) => node.localName === 'input' && (node.getAttribute('type') || '').toLowerCase() === 'password';
  const attrs = [...el.attributes].map((a) => [a.name, secret(el) && a.name === 'value' ? '********' : cut(a.value, 200)]);
  const open = `<${tag}${attrs.map(([n, v]) => (v === '' ? ` ${n}` : ` ${n}="${v.replace(/"/g, '&quot;')}"`)).join('')}>`;
  let html = el.outerHTML.slice(0, 5000).replace(/<input\b[^>]*>/gi, (m) => (/type\s*=\s*["']?password/i.test(m) ? m.replace(/(\svalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/i, '$1"********"') : m));
  html = cut(html.replace(/\s*\n\s*/g, ' '), 700);

  // An element as a selector would name it: its tag, with its id or its classes.
  const IDENT = /^-?[A-Za-z_][\w-]*$/;
  function short(node) {
    if (node.id && IDENT.test(node.id)) return `${node.localName}#${node.id}`;
    const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter((c) => IDENT.test(c)) : [];
    return node.localName + classes.slice(0, 2).map((c) => `.${c}`).join('');
  }
  const ancestors = [];
  for (let a = parentOf(el); a && a.localName !== 'html'; a = parentOf(a)) ancestors.push(a);
  const path = ancestors.map(short).reverse();

  // A selector that finds it and nothing else, the shortest of: its id, a test
  // id, its classes, then a path down from the nearest ancestor with an id.
  const root = el.getRootNode();
  const only = (selector) => {
    try {
      const found = root.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  };
  function selectorOf() {
    const css = (s) => CSS.escape(s);
    if (el.id && only(`#${css(el.id)}`)) return `#${css(el.id)}`;
    for (const name of ['data-testid', 'data-test', 'data-cy', 'name']) {
      const v = el.getAttribute(name);
      if (v && only(`${tag}[${name}="${v.replace(/["\\]/g, '\\$&')}"]`)) return `${tag}[${name}="${v.replace(/["\\]/g, '\\$&')}"]`;
    }
    const classes = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    for (let n = 1; n <= Math.min(classes.length, 3); n++) {
      const s = tag + classes.slice(0, n).map((c) => `.${css(c)}`).join('');
      if (only(s)) return s;
    }
    // Down from the nearest ancestor with an id (or the top), by position among siblings of its kind.
    const steps = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n !== el && n.id && root.querySelectorAll(`#${css(n.id)}`).length === 1) {
        steps.unshift(`#${css(n.id)}`);
        break;
      }
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === n.localName) : [n];
      steps.unshift(same.length > 1 ? `${n.localName}:nth-of-type(${same.indexOf(n) + 1})` : n.localName);
      if (only(steps.join(' > '))) break;
    }
    const s = steps.join(' > ');
    return only(s) ? s : null;
  }

  // ---- what it's called -------------------------------------------------------------

  const IMPLICIT = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button', img: 'img', nav: 'navigation', main: 'main', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', li: 'listitem', option: 'option' };
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', number: 'spinbutton' };
  const given = roleOf(el);
  const role = given || (tag === 'input' ? INPUT_ROLES[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox' : tag === 'a' && !el.hasAttribute('href') ? '' : IMPLICIT[tag] || '');
  const [name, from] = accName(el);

  // ---- where it is, and whether it can be seen ------------------------------------------

  // Its box in this window (a frame of this site is placed where it sits in the window).
  const b = el.getBoundingClientRect();
  let x = b.left;
  let y = b.top;
  for (let win = view; win && win !== window && win.frameElement; win = win.parent) {
    const f = win.frameElement;
    const r = f.getBoundingClientRect();
    const fs = win.parent.getComputedStyle(f);
    x += r.left + f.clientLeft + parseFloat(fs.paddingLeft);
    y += r.top + f.clientTop + parseFloat(fs.paddingTop);
  }

  // Why it can't be seen, if it can't: the first reason that applies, and what sets it.
  function hiddenWhy() {
    const who = (a) => (a === el ? 'it' : describe(a));
    for (let a = el; a; a = parentOf(a)) {
      const s = view.getComputedStyle(a);
      if (s.display === 'none') return `display: none on ${who(a)}`;
      if (a !== el && s.contentVisibility === 'hidden') return `content-visibility: hidden on ${describe(a)}`;
    }
    if (cs.visibility !== 'visible') {
      let setter = el;
      for (let a = parentOf(el); a && view.getComputedStyle(a).visibility === cs.visibility; a = parentOf(a)) setter = a;
      return `visibility: ${cs.visibility} on ${who(setter)}`;
    }
    for (let a = el; a; a = parentOf(a)) if (+view.getComputedStyle(a).opacity === 0) return `opacity: 0 on ${who(a)}`;
    if (b.width < 1 || b.height < 1) return `it has no size (${px(b.width)}×${px(b.height)})`;
    if (b.width <= 1.5 && b.height <= 1.5) return 'it is 1×1: there for screen readers only';
    if (b.right + view.scrollX <= 0 || b.bottom + view.scrollY <= 0) return `it is placed off the page (at ${px(b.left + view.scrollX)}, ${px(b.top + view.scrollY)})`;
    // Cut off by something it's inside of that doesn't show what overflows it.
    for (let a = parentOf(el); a && a !== doc.body && a !== doc.documentElement; a = parentOf(a)) {
      const s = view.getComputedStyle(a);
      if (!/hidden|clip|auto|scroll/.test(`${s.overflowX} ${s.overflowY}`)) continue;
      const r = a.getBoundingClientRect();
      if (b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) continue;
      return /auto|scroll/.test(`${s.overflowX} ${s.overflowY}`)
        ? `scrolled out of view inside ${describe(a)}`
        : `cut off by ${describe(a)} (overflow: ${s.overflowX === s.overflowY ? s.overflowX : `${s.overflowX} ${s.overflowY}`})`;
    }
    return '';
  }

  // ---- how it looks -------------------------------------------------------------------

  // A color as written in CSS: #rrggbb, with its alpha when it's see-through.
  const colorOf = (c) => {
    const v = rgba(c);
    if (!v) return c;
    if (v[3] === 0) return 'transparent';
    return v[3] < 1 ? `${hex(v)} at ${Math.round(v[3] * 100)}%` : hex(v);
  };
  const sides = (name, suffix = '') => {
    const v = ['Top', 'Right', 'Bottom', 'Left'].map((s) => cs[`${name}${s}${suffix}`]);
    if (v.every((s) => s === v[0])) return v[0];
    return v[0] === v[2] && v[1] === v[3] ? `${v[0]} ${v[1]}` : v.join(' ');
  };

  const ownText = clean(el.innerText || (/^(input|textarea)$/.test(tag) && !secret(el) ? el.value : '') || '');
  const colors = { color: colorOf(cs.color) };
  const bg = rgba(cs.backgroundColor);
  if (bg && bg[3] > 0) colors.background = colorOf(cs.backgroundColor);
  if (cs.backgroundImage !== 'none') colors.image = cut(cs.backgroundImage, 80);
  const back = backdrop(el);
  const fg = rgba(cs.color);
  if (back) {
    colors.behind = hex(back.color);
    if (fg && ownText) {
      let seen = over(fg, back.color);
      if (back.opacity < 1) seen = over([...seen.slice(0, 3), back.opacity], back.color);
      colors.contrast = Math.floor(contrast(seen, back.color) * 10) / 10;
    }
  }

  const font = `${cs.fontWeight} ${px(cs.fontSize)}px/${cs.lineHeight === 'normal' ? 'normal' : `${px(cs.lineHeight)}px`} ${cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '')}`;
  const text = [];
  if (!/^(start|left)$/.test(cs.textAlign)) text.push(`text-align ${cs.textAlign}`);
  if (cs.textDecorationLine !== 'none') text.push(`text-decoration ${cs.textDecorationLine}`);
  if (cs.textTransform !== 'none') text.push(`text-transform ${cs.textTransform}`);
  if (cs.whiteSpace !== 'normal') text.push(`white-space ${cs.whiteSpace}`);
  if (cs.textOverflow !== 'clip') text.push(`text-overflow ${cs.textOverflow}`);

  const layout = [`display ${cs.display}`];
  if (cs.position !== 'static') {
    // Left where it would be anyway, a relatively placed box reports 0px all round: nothing to tell.
    const insets = ['top', 'right', 'bottom', 'left'].filter((s) => cs[s] !== 'auto' && !(cs.position === 'relative' && cs[s] === '0px')).map((s) => `${s} ${cs[s]}`);
    layout.push(`position ${cs.position}${insets.length ? ` (${insets.join(', ')})` : ''}`);
  }
  if (cs.zIndex !== 'auto') layout.push(`z-index ${cs.zIndex}`);
  if (cs.float !== 'none') layout.push(`float ${cs.float}`);
  if (cs.boxSizing !== 'content-box') layout.push(`box-sizing ${cs.boxSizing}`);
  if (!/^visible/.test(cs.overflow)) layout.push(`overflow ${cs.overflow}`);

  const box = [];
  if (sides('margin') !== '0px') box.push(`margin ${sides('margin')}`);
  if (sides('padding') !== '0px') box.push(`padding ${sides('padding')}`);
  if (sides('border', 'Width') !== '0px') {
    const same = sides('border', 'Style') === cs.borderTopStyle && sides('border', 'Color') === cs.borderTopColor;
    box.push(`border ${sides('border', 'Width')}${same ? ` ${cs.borderTopStyle} ${colorOf(cs.borderTopColor)}` : ''}`);
  }
  if (cs.borderRadius && cs.borderRadius !== '0px') box.push(`border-radius ${cs.borderRadius}`);
  if (cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px') box.push(`outline ${cs.outlineWidth} ${cs.outlineStyle} ${colorOf(cs.outlineColor)}`);
  if (cs.boxShadow !== 'none') box.push(`box-shadow ${cut(cs.boxShadow, 60)}`);

  // What it lays its children out as, and what its parent lays it out as.
  const flow = [];
  const flex = (s) => /flex$/.test(s.display);
  const grid = (s) => /grid$/.test(s.display);
  const inside = (s) => {
    const parts = [];
    if (flex(s)) {
      parts.push(`flex ${s.flexDirection}${s.flexWrap !== 'nowrap' ? ` ${s.flexWrap}` : ''}`);
      if (s.justifyContent !== 'normal') parts.push(`justify-content ${s.justifyContent}`);
      if (s.alignItems !== 'normal') parts.push(`align-items ${s.alignItems}`);
    } else {
      parts.push(`grid, columns ${cut(s.gridTemplateColumns, 60)}`);
      if (s.gridTemplateRows !== 'none') parts.push(`rows ${cut(s.gridTemplateRows, 60)}`);
    }
    if (!/^normal/.test(s.gap)) parts.push(`gap ${s.gap}`);
    return parts.join(', ');
  };
  if (flex(cs) || grid(cs)) flow.push(`lays out its children as ${inside(cs)}`);
  const parent = parentOf(el);
  const ps = parent ? view.getComputedStyle(parent) : null;
  if (ps && flex(ps)) {
    const self = [`flex ${cs.flexGrow} ${cs.flexShrink} ${cs.flexBasis}`];
    if (cs.alignSelf !== 'auto') self.push(`align-self ${cs.alignSelf}`);
    if (cs.order !== '0') self.push(`order ${cs.order}`);
    flow.push(`an item of ${short(parent)} (${inside(ps)}): ${self.join(', ')}`);
  } else if (ps && grid(ps)) {
    flow.push(`an item of ${short(parent)} (${inside(ps)}): column ${cs.gridColumnStart}${cs.gridColumnEnd !== 'auto' ? ` / ${cs.gridColumnEnd}` : ''}, row ${cs.gridRowStart}${cs.gridRowEnd !== 'auto' ? ` / ${cs.gridRowEnd}` : ''}`);
  }

  const other = [];
  if (!/^(auto|default)$/.test(cs.cursor)) other.push(`cursor ${cs.cursor}`);
  if (cs.opacity !== '1') other.push(`opacity ${cs.opacity}`);
  if (cs.pointerEvents !== 'auto') other.push(`pointer-events ${cs.pointerEvents}`);
  if (cs.userSelect === 'none') other.push('user-select none');
  if (cs.transform !== 'none') other.push(`transform ${cut(cs.transform, 60)}`);
  if (cs.filter !== 'none') other.push(`filter ${cut(cs.filter, 60)}`);
  if (cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0)) other.push(`transition ${cut(`${cs.transitionProperty} ${cs.transitionDuration}`, 60)}`);
  if (cs.animationName !== 'none') other.push(`animation ${cut(`${cs.animationName} ${cs.animationDuration}`, 60)}`);

  // For the session, which asks the browser about these nodes next (see Session.inspect).
  window.__medleyInspect = { el, nodes: [el, ...ancestors, doc.documentElement, doc] };

  return {
    tag,
    open,
    html,
    path,
    selector: selectorOf(),
    shadow: root instanceof ShadowRoot ? short(root.host) : '',
    children: el.childElementCount,
    role,
    roleGiven: !!given,
    name,
    from,
    text: cut(ownText, 200),
    box: { x: px(x), y: px(y), w: px(b.width), h: px(b.height) },
    window: { w: innerWidth, h: innerHeight, sx: Math.round(scrollX), sy: Math.round(scrollY) },
    hidden: hiddenWhy(),
    pointer: cs.pointerEvents === 'none',
    colors,
    font,
    textStyle: text,
    layout,
    boxStyle: box,
    flow,
    other,
    extra: (extra || []).map((p) => [p, cs.getPropertyValue(p) || '(not a property it has)']),
  };
})
