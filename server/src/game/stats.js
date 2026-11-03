// Characters: classes, characteristic points, items and build validation (Dofus 1.29 rules)

export const LEVEL = 200;
export const STAT_POINTS = (LEVEL - 1) * 5; // 995
export const SPELL_POINTS = LEVEL - 1; // 199
export const MAX_SCROLL = 101;

export const CLASSES = {
  1: { name: 'Feca', color: '#d9a441', weapons: { 4: 100, 3: 95 } },
  2: { name: 'Osamodas', color: '#7a5bd1', weapons: { 7: 100, 4: 95 } },
  3: { name: 'Enutrof', color: '#c9a227', weapons: { 8: 100, 7: 95 } },
  4: { name: 'Sram', color: '#5b6b7a', weapons: { 5: 100, 2: 95 } },
  5: { name: 'Xelor', color: '#4a7bd1', weapons: { 7: 100, 3: 95 } },
  6: { name: 'Ecaflip', color: '#d1566a', weapons: { 6: 100, 5: 95 } },
  7: { name: 'Eniripsa', color: '#e07ab8', weapons: { 3: 100, 4: 95 } },
  8: { name: 'Iop', color: '#d1452f', weapons: { 6: 100, 7: 95 } },
  9: { name: 'Cra', color: '#4fa35a', weapons: { 2: 100, 5: 95 } },
  10: { name: 'Sadida', color: '#6f9a2e', weapons: { 4: 100, 3: 95 } },
  11: { name: 'Sacrier', color: '#a3242b', weapons: {} },
  12: { name: 'Pandawa', color: '#3e9c9a', weapons: { 19: 100, 4: 95 } },
};

// Characteristic point costs: stat -> [[from, cost, gain]]
const BOOSTS = {
  1: '10:0@2,50@3,150@4,250@5;11:0@1;12:0@3;13:0@1,20@2,40@3,60@4,80@5;14:0@1,20@2,40@3,60@4,80@5;15:0@1,100@2,200@3,300@4,400@5',
  2: '10:0@2,50@3,150@4,250@5;11:0@1;12:0@3;13:0@1,100@2,200@3,300@4,400@5;14:0@1,20@2,40@3,60@4,80@5;15:0@1,100@2,200@3,300@4,400@5',
  3: '10:0@1,50@2,150@3,250@4,350@5;11:0@1;12:0@3;13:0@1,100@2,150@3,230@4,330@5;14:0@1,20@2,40@3,60@4,80@5;15:0@1,20@2,60@3,100@4,150@5',
  4: '10:0@1,100@2,200@3,300@4,400@5;11:0@1;12:0@3;13:0@1,20@2,40@3,60@4,80@5;14:0@1,100@2,200@3,300@4,400@5;15:0@2,50@3,150@4,250@5',
  5: '10:0@2,50@3,150@4,250@5;11:0@1;12:0@3;13:0@1,20@2,40@3,60@4,80@5;14:0@1,20@2,40@3,60@4,80@5;15:0@1,100@2,200@3,300@4,400@5',
  6: '10:0@1,100@2,200@3,300@4,400@5;11:0@1;12:0@3;13:0@1,20@2,40@3,60@4,80@5;14:0@1,50@2,100@3,150@4,200@5;15:0@1,20@2,40@3,60@4,80@5',
  7: '10:0@2,50@3,150@4,250@5;11:0@1;12:0@3;13:0@1,20@2,40@3,60@4,80@5;14:0@1,20@2,40@3,60@4,80@5;15:0@1,100@2,200@3,300@4,400@5',
  8: '10:0@1,100@2,200@3,300@4,400@5;11:0@1;12:0@3;13:0@1,20@2,40@3,60@4,80@5;14:0@1,20@2,40@3,60@4,80@5;15:0@1,20@2,40@3,60@4,80@5',
  9: '10:0@1,50@2,150@3,250@4,350@5;11:0@1;12:0@3;13:0@1,20@2,40@3,60@4,80@5;14:0@1,50@2,100@3,150@4,200@5;15:0@1,50@2,150@3,250@4,350@5',
  10: '10:0@1,50@2,250@3,300@4,400@5;11:0@1;12:0@3;13:0@1,100@2,200@3,300@4,400@5;14:0@1,20@2,40@3,60@4,80@5;15:0@1,100@2,200@3,300@4,400@5',
  11: '10:0@3,100@4,150@5;11:0@1@2;12:0@3;13:0@3,100@4,150@5;14:0@3,100@4,150@5;15:0@3,100@4,150@5',
  12: '10:0@1,50@2,200@3;11:0@1;12:0@3;13:0@1,50@2,200@3;14:0@1,50@2,200@3;15:0@1,50@2,200@3',
};
const BOOST_STAT = { 10: 'str', 11: 'vit', 12: 'wis', 13: 'cha', 14: 'agi', 15: 'int' };
export const BASE_STATS = ['vit', 'wis', 'str', 'int', 'cha', 'agi'];

export const BOOST_TABLE = {};
for (const [cls, def] of Object.entries(BOOSTS)) {
  BOOST_TABLE[cls] = {};
  for (const part of def.split(';')) {
    const [stat, brackets] = part.split(':');
    BOOST_TABLE[cls][BOOST_STAT[stat]] = brackets.split(',').map(b => {
      const [from, cost, gain] = b.split('@').map(Number);
      return [from, cost, gain || 1];
    });
  }
}

// Points needed to raise a base characteristic from 0 to value
export function pointsFor(cls, stat, value) {
  const table = BOOST_TABLE[cls]?.[stat];
  if (!table) return Infinity;
  let cur = 0, spent = 0;
  while (cur < value) {
    let br = table[0];
    for (const b of table) if (cur >= b[0]) br = b;
    spent += br[1];
    cur += br[2];
  }
  return spent;
}

export function spellPointsFor(level) {
  // level n -> n + 1 costs n points
  let s = 0;
  for (let i = 1; i < level; i++) s += i;
  return s;
}

export const STAT_KEYS = [
  'ap', 'mp', 'range', 'vit', 'wis', 'str', 'int', 'cha', 'agi', 'init', 'summons', 'crit', 'fail',
  'dmg', 'pdmg', 'phys', 'heal', 'trap', 'ptrap', 'reflect', 'dodgeAP', 'dodgeMP',
  'rpN', 'rpE', 'rpF', 'rpW', 'rpA', 'rfN', 'rfE', 'rfF', 'rfW', 'rfA', 'rfPhys', 'rfMagic',
];

export const STAT_LABELS = {
  ap: 'PA', mp: 'PM', range: 'Alcance', vit: 'Vitalidade', wis: 'Sabedoria', str: 'Força', int: 'Inteligência',
  cha: 'Sorte', agi: 'Agilidade', init: 'Iniciativa', summons: 'Invocações', crit: 'Golpes críticos', fail: 'Falhas críticas',
  dmg: 'Dano', pdmg: '% Dano', phys: 'Dano físico', heal: 'Curas', trap: 'Dano de armadilha', ptrap: '% Dano de armadilha',
  reflect: 'Reenvio de dano', dodgeAP: 'Esquiva PA', dodgeMP: 'Esquiva PM',
  rpN: '% Res. Neutro', rpE: '% Res. Terra', rpF: '% Res. Fogo', rpW: '% Res. Água', rpA: '% Res. Ar',
  rfN: 'Res. Neutro', rfE: 'Res. Terra', rfF: 'Res. Fogo', rfW: 'Res. Água', rfA: 'Res. Ar',
  rfPhys: 'Redução física', rfMagic: 'Redução mágica',
};

// Effect id -> [stat, sign]. Used for items, item sets and spell buffs
export const EFFECT_STATS = {
  111: ['ap', 1], 120: ['ap', 1], 168: ['ap', -1], 128: ['mp', 1], 78: ['mp', 1], 169: ['mp', -1],
  117: ['range', 1], 116: ['range', -1], 122: ['fail', 1], 125: ['vit', 1], 110: ['vit', 1], 153: ['vit', -1],
  118: ['str', 1], 157: ['str', -1], 119: ['agi', 1], 154: ['agi', -1], 123: ['cha', 1], 152: ['cha', -1],
  126: ['int', 1], 155: ['int', -1], 124: ['wis', 1], 156: ['wis', -1], 174: ['init', 1], 175: ['init', -1],
  182: ['summons', 1], 183: ['rfPhys', 1], 184: ['rfMagic', 1], 115: ['crit', 1], 171: ['crit', -1], 112: ['dmg', 1], 145: ['dmg', -1],
  138: ['pdmg', 1], 186: ['pdmg', -1], 142: ['phys', 1], 178: ['heal', 1], 179: ['heal', -1],
  225: ['trap', 1], 226: ['ptrap', 1], 220: ['reflect', 1], 160: ['dodgeAP', 1], 162: ['dodgeAP', -1],
  161: ['dodgeMP', 1], 163: ['dodgeMP', -1],
  210: ['rpE', 1], 211: ['rpW', 1], 212: ['rpA', 1], 213: ['rpF', 1], 214: ['rpN', 1],
  215: ['rpE', -1], 216: ['rpW', -1], 217: ['rpA', -1], 218: ['rpF', -1], 219: ['rpN', -1],
  240: ['rfE', 1], 241: ['rfW', 1], 242: ['rfA', 1], 243: ['rfF', 1], 244: ['rfN', 1],
  245: ['rfE', -1], 246: ['rfW', -1], 247: ['rfA', -1], 248: ['rfF', -1], 249: ['rfN', -1],
  // PvP resistances count in every fight of this game
  250: ['rpE', 1], 251: ['rpW', 1], 252: ['rpA', 1], 253: ['rpF', 1], 254: ['rpN', 1],
  255: ['rpE', -1], 256: ['rpW', -1], 257: ['rpA', -1], 258: ['rpF', -1], 259: ['rpN', -1],
  260: ['rfE', 1], 261: ['rfW', 1], 262: ['rfA', 1], 263: ['rfF', 1], 264: ['rfN', 1],
  606: ['wis', 1], 607: ['str', 1], 608: ['cha', 1], 609: ['agi', 1], 610: ['vit', 1], 611: ['int', 1],
};

export const SLOTS = {
  amulet: [1], ring1: [9], ring2: [9], belt: [10], boots: [11], hat: [16], cape: [17, 81],
  weapon: [2, 3, 4, 5, 6, 7, 8, 19, 21, 22], shield: [82], pet: [18],
  dofus1: [23], dofus2: [23], dofus3: [23], dofus4: [23], dofus5: [23], dofus6: [23],
};
export const CONSUMABLE_TYPES = [12, 33];
export const MAX_CONSUMABLES = 3;
export const WEAPON_TYPES = new Set(SLOTS.weapon);

export function itemStats(item) {
  const out = {};
  if (!item) return out;
  for (const [id, , max] of item.effects) {
    // weapon damage lines are not characteristics
    if (item.weapon && id >= 91 && id <= 101) continue;
    const m = EFFECT_STATS[id];
    if (m) out[m[0]] = (out[m[0]] || 0) + m[1] * max;
  }
  return out;
}

export function isHealConsumable(item) {
  return item && CONSUMABLE_TYPES.includes(item.type) && item.effects.some(e => e[0] === 110 && e[2] > 0);
}

// Spell bar order chosen by the player: known ids first in the saved order, then the rest in the default order
// Spell bar layout: spell id -> place on the bar (2 pages of 20). Only known ids, one spell per place.
export const BAR_SLOTS = 40;
export function sanitizeSlots(slots, ids) {
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) return null;
  const known = new Set(ids.map(Number));
  const out = {}; const used = new Set();
  for (const [k, v] of Object.entries(slots)) {
    const id = Number(k), p = Math.floor(Number(v));
    if (!known.has(id) || !(p >= 0 && p < BAR_SLOTS) || used.has(p)) continue;
    used.add(p); out[id] = p;
  }
  return Object.keys(out).length ? out : null;
}

export function orderSpellIds(ids, order) {
  const set = new Set(ids);
  const out = [];
  for (const v of Array.isArray(order) ? order : []) { const id = Number(v); if (set.has(id) && !out.includes(id)) out.push(id); }
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

export function emptyBuild(cls = 8) {
  return {
    name: 'Nova build', cls, sex: 0,
    stats: { vit: 0, wis: 0, str: 0, int: 0, cha: 0, agi: 0 },
    scrolls: { vit: MAX_SCROLL, wis: MAX_SCROLL, str: MAX_SCROLL, int: MAX_SCROLL, cha: MAX_SCROLL, agi: MAX_SCROLL },
    spells: {}, gear: {}, consumables: [],
  };
}

// Check and normalize a build sent by a player. Returns { build, errors }
export function validateBuild(input, data) {
  const errors = [];
  const cls = Number(input?.cls);
  if (!CLASSES[cls]) return { errors: ['Classe inválida'] };
  const b = emptyBuild(cls);
  b.name = String(input.name || 'Build').slice(0, 40);
  b.sex = input.sex ? 1 : 0;
  let spent = 0;
  for (const k of BASE_STATS) {
    const v = Math.max(0, Math.min(2000, Math.floor(Number(input.stats?.[k]) || 0)));
    b.stats[k] = v;
    spent += pointsFor(cls, k, v);
    b.scrolls[k] = Math.max(0, Math.min(MAX_SCROLL, Math.floor(Number(input.scrolls?.[k] ?? MAX_SCROLL))));
  }
  if (spent > STAT_POINTS) errors.push(`Pontos de características: ${spent}/${STAT_POINTS}`);

  const classSpells = data.classSpells[cls];
  let spellSpent = 0;
  for (const id of classSpells) {
    const spell = data.spells[id];
    if (!spell) continue;
    const max = spell.levels.length;
    const lv = Math.max(1, Math.min(max, Math.floor(Number(input.spells?.[id]) || 1)));
    b.spells[id] = lv;
    spellSpent += spellPointsFor(lv);
  }
  // common spells are optional: level 0 means not learned
  for (const id of data.commonSpells || []) {
    const spell = data.spells[id];
    if (!id || !spell || classSpells.includes(id)) continue;
    const lv = Math.max(0, Math.min(spell.levels.length, Math.floor(Number(input.spells?.[id]) || 0)));
    if (!lv) continue;
    b.spells[id] = lv;
    spellSpent += spellPointsFor(lv);
  }
  if (spellSpent > SPELL_POINTS) errors.push(`Pontos de feitiços: ${spellSpent}/${SPELL_POINTS}`);
  b.spellOrder = orderSpellIds([...(data.commonSpells || []), ...classSpells].filter(id => data.spells[id]), input.spellOrder);
  b.spellSlots = sanitizeSlots(input.spellSlots, [...(data.commonSpells || []), ...classSpells]);

  const used = new Set();
  for (const [slot, types] of Object.entries(SLOTS)) {
    const id = Number(input.gear?.[slot]);
    if (!id) continue;
    const item = data.items[id];
    if (!item || !types.includes(item.type) || item.level > LEVEL) { errors.push(`Item inválido em ${slot}`); continue; }
    if ((item.type === 23 || item.type === 9) && used.has(id)) { errors.push(`${item.name} repetido`); continue; }
    used.add(id);
    b.gear[slot] = id;
  }
  const weapon = data.items[b.gear.weapon];
  if (weapon?.weapon?.twoHands && b.gear.shield) errors.push('Arma de duas mãos não permite escudo');
  for (const id of (input.consumables || []).slice(0, MAX_CONSUMABLES)) {
    const item = data.items[Number(id)];
    if (isHealConsumable(item)) b.consumables.push(item.id);
  }
  return { build: b, errors };
}

// Final characteristics of a build (base points + scrolls + items + set bonuses)
export function computeStats(build, data) {
  const s = Object.fromEntries(STAT_KEYS.map(k => [k, 0]));
  const add = (obj) => { for (const [k, v] of Object.entries(obj)) s[k] = (s[k] || 0) + v; };
  for (const k of BASE_STATS) s[k] += (build.stats[k] || 0) + (build.scrolls[k] || 0);
  const sets = {};
  for (const id of Object.values(build.gear)) {
    const item = data.items[id];
    if (!item) continue;
    add(itemStats(item));
    if (item.set) sets[item.set] = (sets[item.set] || 0) + 1;
  }
  const setBonus = [];
  for (const [setId, count] of Object.entries(sets)) {
    const set = data.sets[setId];
    if (!set || count < 2) continue;
    const bonus = set.bonus[count] || set.bonus[Math.max(...Object.keys(set.bonus).map(Number).filter(n => n <= count), 0)];
    if (!bonus) continue;
    const st = {};
    for (const [eid, v] of bonus) {
      const m = EFFECT_STATS[eid];
      if (m) st[m[0]] = (st[m[0]] || 0) + m[1] * v;
    }
    add(st);
    setBonus.push({ id: Number(setId), name: set.name, count, stats: st });
  }
  // class base values
  s.ap += LEVEL >= 100 ? 7 : 6;
  s.mp += 3;
  s.summons += 1;
  s.ap = Math.min(s.ap, 12);
  s.mp = Math.min(s.mp, 6);
  s.range = Math.min(s.range, 6);
  s.dodgeAP += Math.floor(Math.max(s.wis, 0) / 4);
  s.dodgeMP += Math.floor(Math.max(s.wis, 0) / 4);
  s.init += Math.max(s.str, 0) + Math.max(s.int, 0) + Math.max(s.cha, 0) + Math.max(s.agi, 0);
  const perLevel = build.cls === 11 ? 10 : 5;
  const life = 50 + perLevel * LEVEL + Math.max(s.vit, 0) - (build.cls === 11 ? 0 : 0);
  return { stats: s, life, setBonus };
}
