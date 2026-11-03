import { EFFECT_STATS } from './stats.js';

// Simple greedy AI: for each reachable cell and castable, estimate the value of casting and do the best thing.
const DAMAGE = { 96: 'W', 97: 'E', 98: 'A', 99: 'F', 100: 'N', 91: 'W', 92: 'E', 93: 'A', 94: 'F', 95: 'N' };
const ELEM = { N: ['str', 'rpN', 'rfN'], E: ['str', 'rpE', 'rfE'], F: ['int', 'rpF', 'rfF'], W: ['cha', 'rpW', 'rfW'], A: ['agi', 'rpA', 'rfA'] };

function avg(e) { return e.max > e.min ? (e.min + e.max) / 2 : Math.max(e.min, 0); }

function estimateDamage(fight, caster, target, e, weapon) {
  const [st, rp, rf] = ELEM[DAMAGE[e.id]];
  let v = avg(e) * Math.max(100 + fight.stat(caster, st) + fight.stat(caster, 'pdmg'), 0) / 100;
  if (weapon) v *= 0.9;
  v += fight.stat(caster, 'dmg');
  v = v * (100 - Math.min(fight.stat(target, rp), 50)) / 100 - fight.stat(target, rf);
  return Math.max(v, 0);
}

function scoreCast(fight, f, c, cell) {
  let score = 0;
  for (const e of c.lv.effects) {
    if (e.chance) continue;
    const cells = fight.map.area(e.area || 'Pa', f.cell, cell);
    const targets = (e.target & 32) ? [f] : cells.map(x => fight.at(x)).filter(Boolean).filter(t => fight.targetOk(f, t, e.target));
    for (const t of targets) {
      const enemy = t.team !== f.team;
      const w = enemy ? 1 : (t === f ? -2 : -1.5);
      if (DAMAGE[e.id]) {
        if (e.duration > 0) { score += w * estimateDamage(fight, f, t, e, c.kind === 'weapon') * 0.7; continue; }
        const d = estimateDamage(fight, f, t, e, c.kind === 'weapon');
        score += w * Math.min(d, t.life) + (enemy && d >= t.life ? 300 : 0);
      } else if (e.id >= 85 && e.id <= 89) {
        score += w * f.life * avg(e) / 100 * 0.5;
      } else if (e.id === 108 || e.id === 143) {
        if (!enemy) score += Math.min(avg(e) * (100 + fight.stat(f, 'int')) / 100, t.maxLife - t.life) * 0.9;
        else score -= 20;
      } else if ([101, 127, 77, 84, 168, 169].includes(e.id)) {
        score += (enemy ? 25 : -25) * avg(e);
      } else if ([111, 128, 78, 120].includes(e.id)) {
        score += (enemy ? -15 : 15) * avg(e);
      } else if ([105, 265, 107, 106, 210, 211, 212, 213, 214].includes(e.id)) {
        score += enemy ? -10 : (fight.round < 1 && t.buffs.length === 0 ? 25 : 8);
      } else if ([112, 118, 119, 123, 126, 138, 115, 117].includes(e.id)) {
        score += enemy ? -5 : (t.buffs.some(b => b.effect === e) ? 0 : 12);
      } else if (e.id === 5) {
        score += enemy ? 8 : -5;
      } else if (e.id === 140) {
        score += enemy ? 60 : -60;
      } else if (e.id === 141) {
        // a summon that blows itself up (Xelor's needle) means to do it
        if (!(t === f && f.summoner)) score += enemy ? 200 : -200;
      } else if (EFFECT_STATS[e.id]) {
        // any other characteristic buff or debuff
        const good = EFFECT_STATS[e.id][1] > 0;
        const has = t.buffs.some(b => b.effect === e || (b.spellId && b.spellId === c.id));
        if (good) score += enemy ? -2 : (has ? 0 : 10);
        else score += enemy ? (has ? 2 : 12) : -12;
      }
    }
    // Pandawa: lift an adjacent enemy (it can't walk away), then throw it to get the hands free again
    if (e.id === 50 && !f.carrying) { const t = fight.at(cell); if (t && t !== f && !t.static) score += t.team !== f.team ? 15 : 3; }
    if (e.id === 51 && f.carrying) score += 25;
    if ([180, 181, 185].includes(e.id)) score += 70;
    if ([400, 401, 402].includes(e.id)) {
      const near = fight.fighters.some(t => !t.dead && t.team !== f.team && fight.map.dist(t.cell, cell) <= 3);
      score += near ? 30 : 5;
    }
    if (e.id === 4) {
      const enemies = fight.fighters.filter(t => !t.dead && t.team !== f.team && t.cell >= 0);
      const before = Math.min(...enemies.map(t => fight.map.dist(t.cell, f.cell)));
      const after = Math.min(...enemies.map(t => fight.map.dist(t.cell, cell)));
      score += (before - after) * 2;
    }
  }
  return score;
}

function candidateCells(fight, f) {
  const set = new Set();
  for (const t of fight.fighters) {
    if (t.dead || t.cell < 0) continue;
    set.add(t.cell);
    if (t.team !== f.team) for (const n of fight.map.neighbors(t.cell)) set.add(n);
  }
  for (const n of fight.map.neighbors(f.cell)) set.add(n);
  return [...set];
}

export function playTurn(fight, f) {
  for (let step = 0; step < 12; step++) {
    if (fight.phase !== 'fighting' || fight.current() !== f || f.dead) return;
    const reach = fight.reachable(f);
    const origin = f.cell;
    const castables = f.spells.map(s => fight.castable(f, 'spell', s.id));
    if (f.weapon) castables.push(fight.castable(f, 'weapon'));
    let best = null;
    const cells = candidateCells(fight, f);
    for (const [pos, cost] of reach) {
      f.cell = pos;
      for (const c of castables) {
        if (!c || !c.lv || fight.apCost(f, c) > f.ap) continue;
        for (const cell of cells) {
          if (fight.canCast(f, c, cell) !== true) continue;
          const s = scoreCast(fight, f, c, cell) - cost * 0.5;
          if (s > 0 && (!best || s > best.score)) best = { score: s, pos, c, cell };
        }
      }
    }
    f.cell = origin;
    if (!best) break;
    if (best.pos !== f.cell) {
      fight.move(f.id, best.pos);
      if (f.cell !== best.pos) continue; // tackled or stopped
    }
    const r = fight.cast(f.id, best.c.kind, best.c.id, best.cell);
    if (r.error) break;
  }
  if (fight.phase !== 'fighting' || fight.current() !== f || f.dead || f.mp <= 0) return;
  // walk towards the closest enemy
  const enemies = fight.fighters.filter(t => !t.dead && t.team !== f.team && t.cell >= 0);
  if (!enemies.length) return;
  const reach = fight.reachable(f);
  let bestCell = f.cell, bestD = Infinity;
  for (const [cell] of reach) {
    const d = Math.min(...enemies.map(t => fight.map.dist(t.cell, cell)));
    if (d < bestD) { bestD = d; bestCell = cell; }
  }
  if (bestCell !== f.cell) fight.move(f.id, bestCell);
}
