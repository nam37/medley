import { RGBA } from '@opentui/core';

// Page text uses the terminal's own foreground so it suits light and dark
// themes; accents are mid-tones that read on either. The bars are always dark.
export const THEME = {
  text: RGBA.defaultForeground(),
  dim: RGBA.fromHex('#7f848e'),
  link: RGBA.fromHex('#2f9fb8'),
  control: RGBA.fromHex('#c8871a'),
  heading: RGBA.fromHex('#4d8fe0'),
  landmark: RGBA.fromHex('#a35fc9'),
  code: RGBA.fromHex('#5f9e4a'),
  changed: RGBA.fromHex('#46b35c'),
  findFg: RGBA.fromHex('#1b1b1b'),
  findBg: RGBA.fromHex('#e0bf73'),
  findCurrentBg: RGBA.fromHex('#f08c3c'),

  barBg: RGBA.fromHex('#262b33'),
  barFg: RGBA.fromHex('#d8dee9'),
  barDim: RGBA.fromHex('#8a93a3'),
  accentBg: RGBA.fromHex('#2f9fb8'),
  accentFg: RGBA.fromHex('#0f1419'),
  // The badge's background while the session works: a light band sweeps across it.
  accentGlow: ['#2f9fb8', '#5cb4c9', '#8ccadb', '#c0e3ed'].map((hex) => RGBA.fromHex(hex)),

  ok: RGBA.fromHex('#46b35c'),
  warn: RGBA.fromHex('#d19a3a'),
  error: RGBA.fromHex('#e06c75'),
  agent: RGBA.fromHex('#c678dd'),
  recording: RGBA.fromHex('#b3303a'),
};
