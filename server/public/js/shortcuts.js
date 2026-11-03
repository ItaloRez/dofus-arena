// Keyboard shortcuts of the fight spell bar. Bindings use KeyboardEvent.code (the physical key), so they work
// the same on US, ABNT and Mac layouts. Slot n is the n-th place of the bar; the weapon has its own binding.
const KEY = 'shortcuts';
const ROW1 = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const ROW2 = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'];
// the key left of 1: Backquote on US/ABNT, IntlBackslash on Mac ISO keyboards
const WEAPON_KEYS = ['Backquote', 'IntlBackslash'];

export function defaults() {
  const d = { weapon: 'Backquote' };
  [...ROW1, ...ROW2].forEach((c, i) => { d['s' + i] = c; });
  return d;
}

let cache = null;
export function bindings() {
  if (cache) return cache;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  cache = saved && typeof saved === 'object' ? saved : defaults();
  return cache;
}

function save() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {} }

// slot: 'weapon' or 's<n>'. A key bound elsewhere moves to this slot.
export function bind(slot, code) {
  const b = bindings();
  for (const k of Object.keys(b)) if (b[k] === code) delete b[k];
  if (code) b[slot] = code; else delete b[slot];
  save();
}
export function unbind(slot) { const b = bindings(); delete b[slot]; save(); }
export function reset() { cache = defaults(); save(); }

// the slot a key press selects, or null
export function slotFor(code) {
  const b = bindings();
  for (const [slot, c] of Object.entries(b)) if (c === code) return slot;
  // the default weapon key also answers on the other physical variant of "the key left of 1"
  if (b.weapon === 'Backquote' && code === 'IntlBackslash' && !Object.values(b).includes('IntlBackslash')) return 'weapon';
  return null;
}

export function isBound(code) { return slotFor(code) != null; }

const NAMES = {
  Backquote: "'", IntlBackslash: "'", Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: 'Ç', Quote: '~', Comma: ',', Period: '.', Slash: ';', IntlRo: '/', Space: 'Esp', Tab: 'Tab',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: '↵', Backspace: '⌫',
};
export function label(code) {
  if (!code) return '';
  if (NAMES[code]) return NAMES[code];
  let m = code.match(/^Key([A-Z])$/); if (m) return m[1];
  m = code.match(/^Digit(\d)$/); if (m) return m[1];
  m = code.match(/^Numpad(\d)$/); if (m) return 'N' + m[1];
  m = code.match(/^F(\d+)$/); if (m) return code;
  return code.replace(/^(Numpad|Intl)/, '').slice(0, 4);
}

export function keyOf(slot) { return bindings()[slot] || ''; }

// keys that can't be used as shortcuts
export function allowed(code) {
  return !!code && !['Escape', 'Enter', 'Space', 'Tab', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'CapsLock'].includes(code);
}

export const WEAPON_DEFAULT_KEYS = WEAPON_KEYS;
