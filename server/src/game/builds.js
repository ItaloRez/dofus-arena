// Automatic builds: used for AI opponents and the "suggested build" button
import { emptyBuild, pointsFor, spellPointsFor, STAT_POINTS, SPELL_POINTS, SLOTS, itemStats, isHealConsumable, LEVEL } from './stats.js';

const ELEM_OF = { 96: 'cha', 97: 'str', 98: 'agi', 99: 'int', 100: 'str', 91: 'cha', 92: 'str', 93: 'agi', 94: 'int', 95: 'str' };

export function mainStat(data, cls) {
  const score = { str: 0, int: 0, cha: 0, agi: 0 };
  for (const id of data.classSpells[cls]) {
    const lv = data.spells[id]?.levels.at(-1);
    if (!lv) continue;
    for (const e of lv.effects) if (ELEM_OF[e.id]) score[ELEM_OF[e.id]] += Math.max(e.max, e.min, 1);
  }
  return Object.entries(score).sort((a, b) => b[1] - a[1])[0][0];
}

function weights(main, cls) {
  return {
    [main]: 1, vit: 0.35, wis: 0.25, ap: 150, mp: 110, range: 35, dmg: 14, pdmg: 0.8, crit: 9, summons: cls === 2 ? 40 : 6,
    heal: cls === 7 ? 6 : 1, rpN: 4, rpE: 4, rpF: 4, rpW: 4, rpA: 4, rfN: 2, rfE: 2, rfF: 2, rfW: 2, rfA: 2,
    dodgeAP: 1, dodgeMP: 1, init: 0.02,
  };
}

function itemScore(item, w) {
  let s = 0;
  for (const [k, v] of Object.entries(itemStats(item))) s += (w[k] || 0) * v;
  if (item.weapon) {
    for (const [id, min, max] of item.effects) if (id >= 91 && id <= 100) s += (min + max) * 1.5;
    if (item.weapon.twoHands) s -= 40;
  }
  return s;
}

export function randomBuild(data, cls, opts = {}) {
  const b = emptyBuild(cls);
  b.name = opts.name || 'Build sugerida';
  b.sex = Math.random() < 0.5 ? 1 : 0;
  const main = opts.main || mainStat(data, cls);
  // characteristics: everything in the main stat (Sacrier: vitality and strength)
  let left = STAT_POINTS;
  const raise = (stat, budget) => {
    let v = 0;
    while (pointsFor(cls, stat, v + 1) <= budget) v++;
    b.stats[stat] = v;
    return pointsFor(cls, stat, v);
  };
  if (cls === 11) left -= raise('vit', Math.floor(STAT_POINTS / 2));
  left -= raise(main, left);
  if (left > 0) raise('vit', left);

  // spells: damage spells of the main element first
  const spells = data.classSpells[cls].map(id => data.spells[id]).filter(Boolean);
  const value = (sp) => {
    const lv = sp.levels.at(-1);
    let v = 0;
    for (const e of lv.effects) {
      if (ELEM_OF[e.id]) v += (ELEM_OF[e.id] === main ? 3 : 1) * Math.max(e.max, e.min, 1);
      else v += 5;
    }
    return v;
  };
  spells.sort((a, b2) => value(b2) - value(a));
  for (const sp of spells) b.spells[sp.id] = 1;
  let sp = SPELL_POINTS;
  for (const target of [5, 6]) {
    for (const s of spells) {
      const want = Math.min(target, s.levels.length);
      const cost = spellPointsFor(want) - spellPointsFor(b.spells[s.id]);
      if (cost <= sp && want > b.spells[s.id]) { sp -= cost; b.spells[s.id] = want; }
    }
  }

  // gear: best item per slot for the main stat
  const w = weights(main, cls);
  const items = Object.values(data.items).filter(i => i.level <= LEVEL);
  const used = new Set();
  const jitter = opts.random ? () => 0.85 + Math.random() * 0.3 : () => 1;
  for (const [slot, types] of Object.entries(SLOTS)) {
    if (slot === 'shield' && data.items[b.gear.weapon]?.weapon?.twoHands) continue;
    let best = null, bestScore = 0;
    for (const it of items) {
      if (!types.includes(it.type) || used.has(it.id)) continue;
      const s = itemScore(it, w) * jitter();
      if (s > bestScore) { best = it; bestScore = s; }
    }
    if (best) { b.gear[slot] = best.id; used.add(best.id); }
  }
  const potions = items.filter(isHealConsumable)
    .sort((x, y) => y.effects.find(e => e[0] === 110)[2] - x.effects.find(e => e[0] === 110)[2]);
  b.consumables = potions.slice(0, 1).map(i => i.id);
  return b;
}
