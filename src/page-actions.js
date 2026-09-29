// Page-side helpers for acting on refs from a snapshot (see extract.js). The
// file is one expression; call sites evaluate `(<this file>).method(args)`.
// Failures come back as { error } so the message reaches the caller cleanly.
({
  element(ref) {
    const m = window.__medley;
    const el = m && m.els.has(ref) ? m.els.get(ref).deref() : null;
    return el && el.isConnected ? el : null;
  },

  missing(ref) {
    return { error: `ref ${ref} isn't on the page; take a new snapshot for current refs` };
  },

  // Scroll the element into view and find a point where a click lands on it
  // (or on its label), in top-level viewport coordinates. If something else
  // covers it, such as a cookie banner or a modal, say what.
  locate(ref, scroll = true) {
    const el = this.element(ref);
    if (!el) return this.missing(ref);
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    else if (!this.onScreen(el)) return { error: `ref ${ref} isn't on screen`, offScreen: true };
    const doc = el.ownerDocument;
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return { error: `ref ${ref} has no visible box` };
    const lands = (hit) =>
      hit && (this.contains(el, hit) || [...(el.labels || [])].some((label) => this.contains(label, hit)));
    let blocker = null;
    for (const r of rects) {
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        const hit = this.hitTest(doc, x, y);
        if (lands(hit)) return this.toTop(doc, x, y);
        blocker = blocker || hit;
      }
    }
    const dialog = this.dialogAt(blocker);
    return { error: `ref ${ref} is covered by ${this.describe(blocker)}`, dialog: dialog ? this.controls(dialog) : undefined };
  },

  // The modal a hit belongs to, if any. The hit is often its backdrop, which
  // holds the dialog rather than being inside it.
  dialogAt(el) {
    if (!el) return null;
    const DIALOG = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true]';
    return el.closest(DIALOG) || el.querySelector(DIALOG);
  },

  // The refs of a dialog's buttons (or, without any, its other controls), so an
  // error can say how to close it. Only elements a snapshot has numbered have refs.
  controls(dialog) {
    const m = window.__medley;
    const buttons = [];
    const others = [];
    for (const el of dialog.querySelectorAll('*')) {
      const id = m && m.ids.get(el);
      if (!id || !el.checkVisibility()) continue;
      const button = el.localName === 'button' || el.getAttribute('role') === 'button' ||
        (el.localName === 'input' && /^(button|submit|reset)$/.test(el.type));
      (button ? buttons : others).push(id);
    }
    return buttons.length ? buttons : others;
  },

  hitTest(doc, x, y) {
    let hit = doc.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  },

  // Containment that crosses shadow roots.
  contains(a, b) {
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true;
    return false;
  },

  // Convert a point in a (same-origin) iframe to top-level coordinates.
  toTop(doc, x, y) {
    for (let win = doc.defaultView; win && win !== window && win.frameElement; win = win.parent) {
      const frame = win.frameElement;
      const r = frame.getBoundingClientRect();
      x += r.left + frame.clientLeft;
      y += r.top + frame.clientTop;
    }
    return { x, y };
  },

  describe(el) {
    if (!el) return 'nothing (it may be off-screen)';
    const dialog = this.dialogAt(el);
    if (dialog) {
      const name = dialog.getAttribute('aria-label') || (dialog.innerText || '').trim().split('\n')[0];
      return `a dialog${name ? ` "${name.slice(0, 60)}"` : ''}; close it first`;
    }
    // Walk up to something with enough text to recognise.
    let n = el;
    for (let i = 0; i < 3 && n.parentElement && (n.innerText || '').trim().length < 10; i++) n = n.parentElement;
    const cls = typeof n.className === 'string' && n.className.trim()
      ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const text = (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return `<${n.localName}${n.id ? '#' + n.id : ''}${cls}>${text ? ` "${text}"` : ''}`;
  },

  // Focus a text field, selecting its current content so typing replaces it.
  focus(ref) {
    const el = this.element(ref);
    if (!el) return this.missing(ref);
    const role = (el.getAttribute('role') || '').toLowerCase();
    const textInput = el.localName === 'input' &&
      !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/.test(el.type);
    const editable = textInput || el.localName === 'textarea' || el.isContentEditable ||
      /^(textbox|searchbox|combobox)$/.test(role);
    if (!editable) return { error: `ref ${ref} is not a text field` };
    if (el.disabled) return { error: `ref ${ref} is disabled` };
    if (el.readOnly) return { error: `ref ${ref} is read-only` };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (textInput || el.localName === 'textarea') {
      el.select();
    } else if (el.isContentEditable) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      const sel = el.ownerDocument.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return { hasText: !!(el.value || (el.isContentEditable && el.textContent)) };
  },

  // Choose an option of a <select> by its text or value.
  select(ref, wanted) {
    const el = this.element(ref);
    if (!el) return this.missing(ref);
    if (el.localName !== 'select') return { error: `ref ${ref} is not a <select>; click it to open custom dropdowns` };
    if (el.disabled) return { error: `ref ${ref} is disabled` };
    const w = String(wanted).trim().toLowerCase();
    const options = [...el.options];
    const text = (o) => o.text.trim().toLowerCase();
    const match = options.find((o) => text(o) === w) ||
      options.find((o) => o.value.toLowerCase() === w) ||
      options.find((o) => text(o).includes(w));
    if (!match) {
      const names = options.map((o) => `"${o.text.trim()}"`).slice(0, 30).join(', ');
      return { error: `no option matching "${wanted}"; options are ${names}` };
    }
    // Setting .selected (rather than el.value) lets frameworks like React see the change.
    match.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { text: match.text.trim() };
  },

  // Where a child frame's content starts, in this document's top-level
  // viewport; with `scroll`, first bring the frame's element into view.
  frameBox(key, scroll) {
    const held = window.__medleyFrames && window.__medleyFrames.get(key);
    const el = held && held.deref();
    if (!el || !el.isConnected) return { error: 'that frame is no longer on the page; take a new snapshot' };
    if (scroll) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    const x = r.left + el.clientLeft + parseFloat(cs.paddingLeft);
    const y = r.top + el.clientTop + parseFloat(cs.paddingTop);
    return this.toTop(el.ownerDocument, x, y);
  },

  onScreen(el) {
    const r = el.getBoundingClientRect();
    const win = el.ownerDocument.defaultView;
    return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
  },

  // A point on the smallest visible element whose text contains `text` (a drop
  // zone is rarely a control, so it's named by what it says). With `scroll`,
  // bring it into view (only as far as needed) first.
  textPoint(text, scroll) {
    const want = String(text).trim().toLowerCase();
    let best = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (!el.checkVisibility || !el.checkVisibility()) continue;
      const t = (el.innerText || '').trim().toLowerCase();
      if (!t.includes(want)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (!best || r.width * r.height <= best.area) best = { el, area: r.width * r.height };
    }
    if (!best) return { error: `no visible text "${text}" on the page` };
    if (scroll) best.el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    else if (!this.onScreen(best.el)) return { error: `"${text}" isn't on screen`, offScreen: true };
    const r = best.el.getBoundingClientRect();
    return this.toTop(best.el.ownerDocument, r.left + r.width / 2, r.top + r.height / 2);
  },

  // Set a range input (a slider) to a value, as dragging its thumb would.
  setRange(ref, value) {
    const el = this.element(ref);
    if (!el) return this.missing(ref);
    if (el.localName !== 'input' || el.type !== 'range') {
      return { error: `ref ${ref} is a custom slider; move it with press ArrowRight or ArrowLeft after clicking it` };
    }
    if (el.disabled) return { error: `ref ${ref} is disabled` };
    // The native setter, so frameworks that track the value see the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: el.value };
  },

  // Whether a checkbox or radio button (native or ARIA) is checked.
  checked(ref) {
    const el = this.element(ref);
    if (!el) return this.missing(ref);
    if (el.localName === 'input') return { checked: el.checked };
    return { checked: el.getAttribute('aria-checked') === 'true' };
  },

  // Check that a file field can take `count` files, before they're set on it.
  fileField(ref, count) {
    const el = this.element(ref);
    if (!el) return this.missing(ref);
    if (el.localName !== 'input' || el.type !== 'file') return { error: `ref ${ref} is not a file field` };
    if (el.disabled) return { error: `ref ${ref} is disabled` };
    if (count > 1 && !el.multiple) return { error: `ref ${ref} takes one file` };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return {};
  },

  scrollIntoView(ref) {
    const el = this.element(ref);
    if (!el) return this.missing(ref);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return {};
  },

  scrollToEnd(where) {
    const se = document.scrollingElement || document.documentElement;
    se.scrollTo({ top: where === 'top' ? 0 : se.scrollHeight, behavior: 'instant' });
    return {};
  },

  doc() {
    return window.__medley ? window.__medley.doc : null;
  },
})
