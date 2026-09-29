// Key names for `press`: "Enter", "ArrowDown", "a", "Control+a", "Shift+Tab".

export interface KeyPress {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  modifiers: number;
}

const NAMED: Record<string, [key: string, code: string, keyCode: number, text?: string]> = {
  enter: ['Enter', 'Enter', 13, '\r'],
  return: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  del: ['Delete', 'Delete', 46],
  insert: ['Insert', 'Insert', 45],
  space: [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  up: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  down: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  left: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pgup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  pgdn: ['PageDown', 'PageDown', 34],
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = [`F${i}`, `F${i}`, 111 + i];

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const SHIFT = 8;

export function parseKey(spec: string): KeyPress {
  const parts = spec === '+' ? ['+'] : spec.split('+');
  const name = parts.pop()!;
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIERS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${m}"; use Control, Shift, Alt or Meta`);
    modifiers |= bit;
  }
  // With Control, Alt or Meta held a key is a shortcut, not typed text.
  const typing = (modifiers & ~SHIFT) === 0;

  const named = NAMED[name.toLowerCase()];
  if (named) {
    const [key, code, keyCode, text] = named;
    return { key, code, keyCode, text: typing ? text : undefined, modifiers };
  }
  if ([...name].length === 1) {
    const ch = modifiers & SHIFT ? name.toUpperCase() : name;
    const upper = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : '';
    const keyCode = /[a-z\d]/i.test(name) ? upper.charCodeAt(0) : 0;
    return { key: ch, code, keyCode, text: typing ? ch : undefined, modifiers };
  }
  throw new Error(`unknown key "${name}"; try Enter, Tab, Escape, ArrowDown, PageDown, a single character, or Control+a`);
}
