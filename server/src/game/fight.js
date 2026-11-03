// Turn-based tactical fight with Dofus 1.29 rules. Authoritative: clients only send intents.
import { STAT_KEYS, EFFECT_STATS, CLASSES, computeStats, orderSpellIds, sanitizeSlots } from './stats.js';
import { playTurn } from './ai.js';

// lang_pt config C.ZONE_COLOR (dofus.Constants.ZONE_COLOR), indexed by the 3rd field of the GDZ packet
const ZONE_COLOR = [0xFFFFFF, 0x000000, 0xD03314, 0x312D86, 0xCA1330, 0x22751C, 0x312D86, 0x5A341C, 0x5A341C, 0x691C75, 0x22751C, 0x312D86, 0x9BF0ED, 0x000000];
const ZONE_SIZE_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const zoneRgb = (i) => '#' + (ZONE_COLOR[i] ?? 0xFFFFFF).toString(16).padStart(6, '0');

export const TURN_TIME = 30000;
export const PLACEMENT_TIME = 30000;

// element: stat boosting it, % resistance, fixed resistance
const ELEMENTS = {
  N: { stat: 'str', rp: 'rpN', rf: 'rfN', physical: true },
  E: { stat: 'str', rp: 'rpE', rf: 'rfE', physical: true },
  F: { stat: 'int', rp: 'rpF', rf: 'rfF' },
  W: { stat: 'cha', rp: 'rpW', rf: 'rfW' },
  A: { stat: 'agi', rp: 'rpA', rf: 'rfA' },
};
const DAMAGE = { 96: 'W', 97: 'E', 98: 'A', 99: 'F', 100: 'N' };
const STEAL = { 91: 'W', 92: 'E', 93: 'A', 94: 'F', 95: 'N' };
const PERCENT_LIFE = { 85: 'W', 86: 'E', 87: 'A', 88: 'F', 89: 'N', 671: 'N' };
const STEAL_STAT = { 267: 'vit', 268: 'agi', 269: 'int', 271: 'str', 320: 'range' };
const ON_DAMAGE_STAT = { 108: 'vit', 118: 'str', 119: 'agi', 123: 'cha', 126: 'int', 138: 'pdmg' };
const RES_CAP = 50;
const STATE_ROOTED = 6;
const STATE_CARRYING = 3; // Pandawa holding someone
const STATE_CARRIED = 8;
const DAMAGE_EFFECTS = new Set([...Object.keys(DAMAGE), ...Object.keys(STEAL), ...Object.keys(PERCENT_LIFE), '82', '144', '672'].map(Number));

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
let UID = 1;

function effectValue(e) {
  if (e.max === undefined || e.max === -1 || e.max <= e.min) return Math.max(e.min, 0);
  return rand(e.min, e.max);
}

// Brokle (782) maximizes and Poisse (781) minimizes the random rolls of the fighter under the effect
function rollFor(e, f) {
  if (f && e.max !== undefined && e.max > e.min && f.buffs) {
    const max = f.buffs.some(b => b.kind === 'maxRoll'), min = f.buffs.some(b => b.kind === 'minRoll');
    if (max && !min) return e.max;
    if (min && !max) return Math.max(e.min, 0);
  }
  return effectValue(e);
}

function attenuate(v, dist) {
  return Math.floor(v * Math.pow(0.9, dist));
}

export class Fight {
  // teams: [[spec...], [spec...]]; spec = { accountId, name, build, bot }
  constructor({ id, mode, map, teams, data, ranked = false, onUpdate, onEnd, timers = true }) {
    this.id = id;
    this.mode = mode;
    this.map = map;
    this.data = data;
    this.ranked = ranked;
    this.onUpdate = onUpdate || (() => {});
    this.onEnd = onEnd || (() => {});
    this.timers = timers;
    this.fighters = [];
    this.order = [];
    this.turnIndex = -1;
    this.round = 0;
    this.phase = 'placement';
    this.events = [];
    this.traps = [];
    this.glyphs = [];
    this.log = [];
    this.winner = null;
    this.deadline = 0;
    this.timer = null;
    let fid = 1;
    teams.forEach((team, t) => team.forEach((spec, i) => {
      const f = this.createPlayerFighter(fid++, t, spec);
      f.cell = this.map.placement[t][i % this.map.placement[t].length];
      f.ready = !!spec.bot;
      this.fighters.push(f);
    }));
    this.deadline = Date.now() + PLACEMENT_TIME;
    if (this.timers) this.timer = setTimeout(() => this.startFight(), PLACEMENT_TIME);
  }

  createPlayerFighter(id, team, spec) {
    if (spec.dummy) return this.createDummy(id, team, spec);
    const { build } = spec;
    const { stats, life } = computeStats(build, this.data);
    const weapon = this.data.items[build.gear.weapon] || null;
    const spells = [];
    const all = [...this.data.commonSpells, ...this.data.classSpells[build.cls]];
    for (const sid of orderSpellIds(all, build.spellOrder)) {
      if (sid === 0 && weapon) continue;
      const sp = this.data.spells[sid];
      if (!sp) continue;
      // common spells only when learned in the build
      if (sid !== 0 && !this.data.classSpells[build.cls].includes(sid) && !(build.spells[sid] >= 1)) continue;
      spells.push({ id: sid, level: Math.min(build.spells[sid] || 1, sp.levels.length) });
    }
    return {
      id, team, name: spec.name, accountId: spec.accountId || null, bot: !!spec.bot, buildId: spec.buildId ?? null,
      cls: build.cls, level: 200, gfx: build.cls * 10 + (build.sex ? 1 : 0), summoner: null, static: false,
      base: stats, life, baseMaxLife: life, maxLife: life,
      cell: -1, dead: false, ap: 0, mp: 0, buffs: [], spells, weapon,
      slots: sanitizeSlots(build.spellSlots, spells.map(s => s.id)), // places on the spell bar (2 pages)
      consumables: [], // 1.29 has no consumables during fights
      cooldowns: {}, turnCasts: {}, turnTargets: {}, apUsed: 0, connected: true,
    };
  }

  // Training scarecrow: lots of life, never acts (static fighters skip their turns)
  createDummy(id, team, spec) {
    const base = Object.fromEntries(STAT_KEYS.map(k => [k, 0]));
    const life = spec.life || 100000;
    return {
      id, team, name: spec.name || 'Espantalho', accountId: null, bot: true, dummy: true,
      cls: 0, level: 200, gfx: Number(process.env.DUMMY_GFX) || 0, summoner: null, static: true,
      base, life, baseMaxLife: life, maxLife: life, cell: -1, dead: false, ap: 0, mp: 0, buffs: [], spells: [], weapon: null,
      consumables: [], cooldowns: {}, turnCasts: {}, turnTargets: {}, apUsed: 0, connected: true,
    };
  }

  // Sandbox: swap the player's character for another class, keeping its place
  changeClass(fid, spec) {
    const old = this.fighter(fid);
    if (!old || this.mode !== 'sandbox') return { error: 'Só no treino' };
    for (const f of this.fighters) if (f.summoner === old.id && !f.dead) this.kill(f, old);
    if (old.carrying) { const t = this.fighter(old.carrying); if (t) this.drop(old, t, old.cell); }
    const cell = old.cell;
    const nf = this.createPlayerFighter(old.id, old.team, spec);
    nf.cell = cell; nf.ready = true;
    for (const f of this.fighters) f.buffs = f.buffs.filter(b => b.casterId !== old.id);
    this.fighters[this.fighters.indexOf(old)] = nf;
    this.traps = this.traps.filter(t => t.ownerId !== old.id);
    this.glyphs = this.glyphs.filter(g => g.ownerId !== old.id);
    this.refill();
    this.emit({ type: 'log', text: `Classe trocada para ${CLASSES[nf.cls]?.name || ''}` });
    this.flush();
    return { ok: true };
  }

  // Reorders the spell bar of a fighter (any time, it changes nothing in the rules). Returns the new order.
  // order: spell ids in bar order; slots (optional): spell id -> place on the bar (page 1 = 0-19, page 2 = 20-39)
  setSpellOrder(fid, order, slots) {
    const f = this.fighter(fid);
    if (!f || !Array.isArray(order) || !f.spells) return null;
    const ids = orderSpellIds(f.spells.map(s => s.id), order);
    f.spells = ids.map(id => f.spells.find(s => s.id === id));
    if (slots !== undefined) f.slots = sanitizeSlots(slots, ids);
    this.flush();
    return { ids, slots: f.slots || null };
  }

  // Sandbox: the player always has full AP/MP and no cooldowns; the scarecrow never runs out of life
  refill() {
    if (this.mode !== 'sandbox' || this.phase !== 'fighting') return;
    for (const f of this.fighters) {
      if (f.dummy) { if (f.dead) { f.dead = false; } if (f.life < f.maxLife * 0.25) f.life = f.maxLife; continue; }
      if (f.summoner || f.dead) continue;
      f.ap = Math.max(0, this.stat(f, 'ap')); f.mp = Math.max(0, this.stat(f, 'mp'));
      f.cooldowns = {}; f.turnCasts = {}; f.turnTargets = {};
    }
  }

  // ---------------------------------------------------------------- helpers

  stat(f, k) {
    let v = f.base[k] || 0;
    for (const b of f.buffs) if (b.stat === k) v += b.value;
    return v;
  }

  hasState(f, st) { return f.buffs.some(b => b.kind === 'state' && b.state === st); }
  invisible(f) { return f.buffs.some(b => b.kind === 'invis'); }
  fighter(id) { return this.fighters.find(f => f.id === id); }
  at(cell) { return this.fighters.find(f => !f.dead && f.cell === cell && !f.carriedBy); }
  current() { return this.fighters.find(f => f.id === this.order[this.turnIndex]); }
  alive(team) { return this.fighters.filter(f => !f.dead && f.team === team); }
  emit(ev) {
    // an invisible fighter moved by a spell (push, teleport, swap): enemies must not learn the cell (see server filterEvents)
    if ((ev.type === 'slide' || ev.type === 'tp') && ev.id != null) { const f = this.fighter(ev.id); if (f && this.invisible(f)) ev.hidden = true; }
    this.events.push(ev);
  }
  spellDef(id) { return this.data.spells[id]; }

  // ---------------------------------------------------------------- placement

  place(fid, cell) {
    const f = this.fighter(fid);
    if (this.phase !== 'placement' || !f || f.ready) return false;
    if (!this.map.placement[f.team].includes(cell)) return false;
    const other = this.at(cell);
    if (other && other.team !== f.team) return false;
    if (other) other.cell = f.cell;
    f.cell = cell;
    this.flush();
    return true;
  }

  setReady(fid, ready = true) {
    const f = this.fighter(fid);
    if (this.phase !== 'placement' || !f) return;
    f.ready = ready;
    if (this.fighters.every(x => x.ready || !x.connected)) this.startFight();
    else this.flush();
  }

  startFight() {
    if (this.phase !== 'placement') return;
    clearTimeout(this.timer);
    this.phase = 'fighting';
    for (const f of this.fighters) f.startCell = f.cell;
    // turn order: initiative, alternating teams (Dofus style)
    const lists = [0, 1].map(t => this.fighters.filter(f => f.team === t)
      .sort((a, b) => this.stat(b, 'init') * b.life / b.maxLife - this.stat(a, 'init') * a.life / a.maxLife));
    const first = (lists[0][0] && lists[1][0] && this.stat(lists[1][0], 'init') > this.stat(lists[0][0], 'init')) ? 1 : 0;
    this.order = [];
    for (let i = 0; i < Math.max(lists[0].length, lists[1].length); i++) {
      if (lists[first][i]) this.order.push(lists[first][i].id);
      if (lists[1 - first][i]) this.order.push(lists[1 - first][i].id);
    }
    this.emit({ type: 'start' });
    this.turnIndex = -1;
    this.nextTurn();
  }

  // ---------------------------------------------------------------- turns

  nextTurn() {
    if (this.phase !== 'fighting') return;
    clearTimeout(this.timer);
    for (let guard = 0; guard < this.order.length * 2 + 2; guard++) {
      this.turnIndex++;
      if (this.turnIndex >= this.order.length) { this.turnIndex = 0; this.round++; }
      const f = this.current();
      if (!f || f.dead || f.static) continue;
      this.startTurn(f);
      if (this.phase !== 'fighting') return;
      if (f.dead) continue;
      if (f.skipTurn) { f.skipTurn = false; this.emit({ type: 'log', text: `${f.name} perde o turno` }); this.endTurnEffects(f); continue; }
      this.deadline = Date.now() + TURN_TIME;
      if (this.timers) {
        const turnId = this.turnIndex + ':' + this.round;
        this.timer = setTimeout(() => {
          if (this.turnIndex + ':' + this.round === turnId) this.passTurn(f.id);
        }, TURN_TIME);
      }
      this.emit({ type: 'turn', id: f.id, round: this.round });
      this.flush();
      if (f.bot || (f.summoner && !f.controlled)) this.scheduleAI(f);
      return;
    }
  }

  startTurn(f) {
    // durations of everything this fighter cast go down at the start of his turn
    for (const t of this.fighters) {
      for (const b of [...t.buffs]) {
        if (b.casterId !== f.id || b.duration < 0) continue;
        b.duration--;
        if (b.duration <= 0) this.removeBuff(t, b);
      }
    }
    for (const g of [...this.glyphs]) {
      if (g.ownerId !== f.id) continue;
      g.duration--;
      if (g.duration <= 0) { this.glyphs.splice(this.glyphs.indexOf(g), 1); this.emit({ type: 'glyphEnd', id: g.id }); }
    }
    for (const k of Object.keys(f.cooldowns)) { if (--f.cooldowns[k] <= 0) delete f.cooldowns[k]; }
    f.turnCasts = {};
    f.turnTargets = {};
    f.apUsed = 0;
    f.ap = Math.max(0, this.stat(f, 'ap'));
    f.mp = Math.max(0, this.stat(f, 'mp'));
    f.consumedThisTurn = false;
    // poisons and other start-of-turn buffs
    for (const b of [...f.buffs]) {
      if (f.dead) break;
      if (b.kind === 'dot') this.applyDot(f, b);
      if (b.kind === 'skip') f.skipTurn = true;
      if (b.kind === 'turnSpell') {
        this.removeBuff(f, b);
        const sp = this.spellDef(b.spellCast);
        const lv = sp?.levels[Math.min(b.spellLevel, sp.levels.length) - 1];
        if (lv) {
          this.emit({ type: 'cast', id: f.id, kind: 'spell', spell: b.spellCast, name: sp.name, cell: f.cell, from: f.cell, ap: 0 });
          this.applyEffects(f, lv.effects, f.cell, { spellId: b.spellCast, sourceLevel: b.spellLevel });
        }
      }
    }
    // glyphs under the fighter
    for (const g of [...this.glyphs]) {
      if (f.dead) break;
      if (!g.endTurn && g.cells.includes(f.cell)) this.triggerZone(g, f);
    }
  }

  endTurnEffects(f) {
    for (const b of [...f.buffs]) {
      if (b.kind === 'apPoison' && f.apUsed > 0 && !f.dead) {
        const caster = this.fighter(b.casterId) || f;
        const per = b.value;
        this.damage(caster, f, per * f.apUsed, 'A', { indirect: true, boosted: true });
      }
    }
    for (const g of [...this.glyphs]) {
      if (f.dead) break;
      if (g.endTurn && g.cells.includes(f.cell)) this.triggerZone(g, f);
    }
  }

  passTurn(fid) {
    const f = this.current();
    if (this.phase !== 'fighting' || !f || f.id !== fid) return false;
    this.endTurnEffects(f);
    if (this.phase !== 'fighting') return true;
    this.emit({ type: 'endTurn', id: f.id });
    this.nextTurn();
    this.flush();
    return true;
  }

  scheduleAI(f) {
    const run = () => {
      if (this.phase !== 'fighting' || this.current()?.id !== f.id) return;
      try { playTurn(this, f); } catch (e) { console.error('AI error', e); }
      if (this.phase === 'fighting' && this.current()?.id === f.id) this.passTurn(f.id);
    };
    if (this.timers) setTimeout(run, 700); else this.pendingAI = run;
  }

  // ---------------------------------------------------------------- movement

  reachable(f) {
    // cells reachable with the current MP: BFS without passing through fighters
    const dist = new Map([[f.cell, 0]]);
    const queue = [f.cell];
    while (queue.length) {
      const c = queue.shift();
      const d = dist.get(c);
      if (d >= f.mp) continue;
      if (c !== f.cell && this.adjacentEnemy(f, c)) continue; // stops on tackle zones
      for (const n of this.map.neighbors(c)) {
        if (dist.has(n) || !this.map.cells[n].walk || this.at(n)) continue;
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
    return dist;
  }

  path(f, to) {
    const prev = new Map([[f.cell, -1]]);
    const queue = [f.cell];
    while (queue.length) {
      const c = queue.shift();
      if (c === to) break;
      for (const n of this.map.neighbors(c)) {
        if (prev.has(n) || !this.map.cells[n].walk || this.at(n)) continue;
        prev.set(n, c);
        queue.push(n);
      }
    }
    if (!prev.has(to)) return null;
    const p = [];
    for (let c = to; c !== -1; c = prev.get(c)) p.unshift(c);
    return p;
  }

  adjacentEnemy(f, cell) {
    return this.map.neighbors(cell).some(n => { const o = this.at(n); return o && o.team !== f.team && !o.static; });
  }

  move(fid, to) {
    const f = this.current();
    if (this.phase !== 'fighting' || !f || f.id !== fid || f.dead) return { error: 'Não é seu turno' };
    if (f.mp <= 0) return { error: 'Sem PM' };
    if (f.carriedBy) return { error: 'Você está sendo carregado' };
    let path = this.path(f, to);
    if (!path || path.length < 2) return { error: 'Caminho inválido' };
    path = path.slice(0, f.mp + 1);
    // tackle when leaving a cell next to enemies
    if (!this.hasState(f, STATE_ROOTED)) {
      let escape = 1;
      for (const n of this.map.neighbors(f.cell)) {
        const e = this.at(n);
        if (!e || e.team === f.team || e.static || this.hasState(e, STATE_ROOTED)) continue;
        const a = Math.max(this.stat(f, 'agi'), 0), b = Math.max(this.stat(e, 'agi'), 0);
        const chance = Math.min(1, Math.max(0, 3 * (a + 25) / Math.max(a + b + 50, 1) - 1));
        escape *= chance;
      }
      if (Math.random() > escape) {
        const lostAp = Math.floor(f.ap * (1 - escape));
        f.ap -= lostAp;
        f.mp = 0;
        this.emit({ type: 'tackled', id: f.id, ap: lostAp });
        this.flush();
        return { ok: true };
      }
    }
    // stop next to enemies, or on traps
    const real = [path[0]];
    for (let i = 1; i < path.length; i++) {
      real.push(path[i]);
      if (this.trapAt(path[i])) break;
      if (i < path.length - 1 && this.adjacentEnemy(f, path[i])) break;
    }
    f.mp -= real.length - 1;
    f.cell = real[real.length - 1];
    this.emit({ type: 'move', id: f.id, path: real, hidden: this.invisible(f) });
    this.checkTraps(f);
    this.flush();
    return { ok: true };
  }

  trapAt(cell) { return this.traps.find(t => t.cells.includes(cell)); }

  checkTraps(f) {
    const t = this.trapAt(f.cell);
    if (!t || f.dead) return;
    this.traps.splice(this.traps.indexOf(t), 1);
    this.emit({ type: 'trap', id: t.id, cell: t.cell, spell: t.spell });
    const owner = this.fighter(t.ownerId);
    if (!owner) return;
    const sp = this.spellDef(t.spell);
    const lv = sp?.levels[Math.min(t.level, sp.levels.length) - 1];
    if (lv) this.applyEffects(owner, lv.effects, t.cell, { spellId: t.spell, trap: true, origin: t.cell, sourceLevel: t.level });
  }

  triggerZone(g, f) {
    const owner = this.fighter(g.ownerId);
    const sp = this.spellDef(g.spell);
    const lv = sp?.levels[Math.min(g.level, sp.levels.length) - 1];
    if (!owner || !lv) return;
    this.emit({ type: 'glyphHit', id: g.id, target: f.id });
    this.applyEffects(owner, lv.effects, f.cell, { spellId: g.spell, onlyTarget: f, origin: g.cell, glyph: true });
  }

  // ---------------------------------------------------------------- casting

  spellRange(f, lv) {
    let max = lv.maxRange;
    if (lv.boostRange) max += this.stat(f, 'range');
    max = Math.max(max, lv.minRange);
    return [lv.minRange, max];
  }

  blocksSight(cell) {
    const c = this.map.cells[cell];
    return !c.los || !!this.at(cell);
  }

  // A castable: { kind: 'spell'|'weapon', id, lv } where lv has ap/range/los...
  castable(f, kind, id) {
    if (kind === 'weapon') {
      const w = f.weapon;
      if (!w) return null;
      const effects = w.effects.filter(e => (e[0] >= 91 && e[0] <= 101) || e[0] === 108)
        .map(([eid, min, max]) => ({ id: eid, min, max, special: -1, duration: 0, chance: 0, area: 'Pa', target: 0 }));
      const crit = effects.map(e => DAMAGE[e.id] || STEAL[e.id]
        ? { ...e, min: e.min + (w.weapon.critBonus || 0), max: Math.max(e.max, e.min) + (w.weapon.critBonus || 0) } : e);
      const area = w.type === 7 ? 'Tb' : w.type === 8 ? 'Lb' : w.type === 4 ? 'Tb' : w.type === 22 ? 'Lb' : 'Pa';
      // hammers, staffs and shovels hit an area, like in 1.29
      if (area !== 'Pa' && effects[0]) {
        for (const list of [effects, crit]) list.forEach((e, i) => { e.area = i === 0 || DAMAGE[e.id] || STEAL[e.id] ? area : 'Pa'; });
      }
      return {
        kind, id: w.id, name: w.name,
        lv: {
          effects, critical: crit, ap: w.weapon.ap || 4, minRange: w.weapon.minRange || 1, maxRange: w.weapon.maxRange || 1,
          critRate: w.weapon.critRate || 0, failRate: w.weapon.failRate || 0, lineOnly: false, los: true, freeCell: false,
          boostRange: false, perTurn: 1, perTarget: 0, cooldown: 0, requiredStates: [], forbiddenStates: [], endsTurnOnFail: true,
        },
      };
    }
    const s = f.spells.find(x => x.id === id);
    if (!s) return null;
    const def = this.spellDef(id);
    return { kind, id, name: def.name, lv: def.levels[s.level - 1], level: s.level };
  }

  // Checks that do not depend on the target (SpellsManager.checkCanLaunchSpell): the client greys the shortcut
  // out when this fails. Returns true or { type, msg }.
  spellUsable(f, c) {
    const lv = c.lv;
    if (f.ap < this.apCost(f, c)) return { type: 'ap', msg: 'PA insuficientes' };
    if (c.kind === 'spell') {
      if (f.cooldowns[c.id]) return { type: 'cooldown', msg: `Disponível em ${f.cooldowns[c.id]} turno(s)` };
      if (lv.perTurn > 0 && (f.turnCasts[c.id] || 0) >= lv.perTurn) return { type: 'limit', msg: 'Limite de lançamentos por turno' };
    } else if ((f.turnCasts.weapon || 0) >= 1) return { type: 'limit', msg: 'Arma já usada neste turno' };
    for (const st of lv.requiredStates || []) if (!this.hasState(f, st)) return { type: 'state', msg: 'Estado necessário ausente' };
    for (const st of lv.forbiddenStates || []) if (this.hasState(f, st)) return { type: 'state', msg: 'Estado proibido' };
    // Chamrak only works while carrying someone, Karcham only while not
    if (lv.effects.some(e => e.id === 51) && !f.carrying) return { type: 'state', msg: 'Você não está carregando ninguém' };
    if (lv.effects.some(e => e.id === 50) && f.carrying) return { type: 'state', msg: 'Você já está carregando alguém' };
    if (lv.effects.some(e => e.id === 181 || e.id === 180) && this.summonCount(f) >= this.stat(f, 'summons')) return { type: 'summon', msg: 'Limite de invocações' };
    return true;
  }

  // usability of each spell / the weapon for the fighter, sent to its own team
  usableMap(f) {
    const out = {};
    for (const s of f.spells || []) { const c = this.castable(f, 'spell', s.id); if (c && c.lv) { const u = this.spellUsable(f, c); out[s.id] = u === true ? 1 : u.type; } }
    if (f.weapon) { const c = this.castable(f, 'weapon', f.weapon.id); if (c && c.lv) { const u = this.spellUsable(f, c); out.weapon = u === true ? 1 : u.type; } }
    return out;
  }

  canCast(f, c, cell, explain = false) {
    const fail = (m) => (explain ? m : false);
    const lv = c.lv;
    if (!this.map.cells[cell]) return fail('Célula inválida');
    const u = this.spellUsable(f, c);
    if (u !== true) return fail(u.msg);
    const [min, max] = this.spellRange(f, lv);
    const d = this.map.dist(f.cell, cell);
    if (d < min || d > max) return fail('Fora de alcance');
    if (lv.lineOnly && !this.map.inLine(f.cell, cell)) return fail('Só em linha');
    const target = this.at(cell);
    if (!this.map.cells[cell].walk && !target) return fail('Célula inválida');
    if (lv.freeCell && target) return fail('Célula ocupada');
    if (lv.perTarget > 0 && target && (f.turnTargets[c.id]?.[target.id] || 0) >= lv.perTarget) return fail('Limite por alvo');
    if (lv.los && !this.map.lineOfSight(f.cell, cell, id => this.blocksSight(id))) return fail('Sem linha de visão');
    // summons need a free cell and a free summon slot
    const effects = [...lv.effects];
    if (effects.some(e => [180, 181, 185, 4, 400, 401, 402].includes(e.id)) && target) return fail('Célula ocupada');
    if (effects.some(e => e.id === 181 || e.id === 180) && this.summonCount(f) >= this.stat(f, 'summons')) return fail('Limite de invocações');
    return true;
  }

  apCost(f, c) {
    let cost = c.lv.ap;
    for (const b of f.buffs) if (b.kind === 'spellAp' && b.spellId === c.id) cost -= b.value;
    return Math.max(cost, 0);
  }

  summonCount(f) { return this.fighters.filter(x => !x.dead && x.summoner === f.id && !x.static).length; }

  cast(fid, kind, id, cell) {
    const f = this.current();
    if (this.phase !== 'fighting' || !f || f.id !== fid || f.dead) return { error: 'Não é seu turno' };
    const c = this.castable(f, kind, id);
    if (!c || !c.lv) return { error: 'Feitiço desconhecido' };
    const ok = this.canCast(f, c, cell, true);
    if (ok !== true) return { error: ok };
    const cost = this.apCost(f, c);
    f.ap -= cost;
    f.apUsed += cost;
    const key = kind === 'weapon' ? 'weapon' : c.id;
    f.turnCasts[key] = (f.turnCasts[key] || 0) + 1;
    const target = this.at(cell);
    if (target) {
      f.turnTargets[key] = f.turnTargets[key] || {};
      f.turnTargets[key][target.id] = (f.turnTargets[key][target.id] || 0) + 1;
    }
    if (kind === 'spell' && c.lv.cooldown > 0) f.cooldowns[c.id] = c.lv.cooldown;
    // critical failure
    const failRate = c.lv.failRate > 0 ? Math.max(c.lv.failRate - this.stat(f, 'fail'), 2) : 0;
    if (failRate && Math.random() < 1 / failRate) {
      this.emit({ type: 'cast', id: f.id, kind, spell: c.id, name: c.name, cell, fail: true, from: f.cell, ap: cost });
      if (c.lv.endsTurnOnFail) { this.flush(); this.passTurn(f.id); return { ok: true, fail: true }; }
      this.flush();
      return { ok: true, fail: true };
    }
    let critBase = c.lv.critRate;
    for (const b of f.buffs) if (b.kind === 'spellCrit' && b.spellId === c.id) critBase -= b.value;
    const crit = c.lv.critical.length > 0 && critBase > 0 && Math.random() < 1 / this.critRate(f, critBase);
    this.emit({ type: 'cast', id: f.id, kind, spell: c.id, name: c.name, cell, crit, from: f.cell, ap: cost });
    // revealed when attacking while invisible
    if (this.invisible(f)) this.emit({ type: 'reveal', id: f.id, cell: f.cell });
    const effects = crit ? c.lv.critical : c.lv.effects;
    this.applyEffects(f, effects, cell, {
      spellId: kind === 'spell' ? c.id : null, weapon: kind === 'weapon' ? f.weapon : null, sourceLevel: c.level,
    });
    this.flush();
    return { ok: true, crit };
  }

  critRate(f, base) {
    if (base <= 2) return Math.max(base, 1);
    base -= this.stat(f, 'crit');
    const agi = Math.max(this.stat(f, 'agi'), 0);
    const rate = Math.min(Math.floor(base * 2.9901 / Math.log(agi + 12)), base);
    return Math.max(rate, 2);
  }

  useItem(fid, index) {
    const f = this.current();
    if (this.phase !== 'fighting' || !f || f.id !== fid) return { error: 'Não é seu turno' };
    const slot = f.consumables[index];
    if (!slot || slot.used) return { error: 'Consumível indisponível' };
    if (f.ap < 3) return { error: 'PA insuficientes (3)' };
    if (f.consumedThisTurn) return { error: 'Um consumível por turno' };
    const item = this.data.items[slot.itemId];
    f.ap -= 3;
    f.apUsed += 3;
    slot.used = true;
    f.consumedThisTurn = true;
    const heal = item.effects.filter(e => e[0] === 110).reduce((s, e) => s + e[2], 0);
    this.emit({ type: 'item', id: f.id, name: item.name });
    this.heal(f, f, heal);
    this.flush();
    return { ok: true };
  }

  // ---------------------------------------------------------------- effects

  targetOk(caster, target, flags) {
    if (!flags) return true;
    if (flags & 32) return target === caster;
    if ((flags & 1) && target.team === caster.team) return false;
    if ((flags & 2) && target === caster) return false;
    if ((flags & 4) && target.team !== caster.team) return false;
    if ((flags & 8) && !target.summoner) return false;
    if ((flags & 16) && target.summoner) return false;
    return true;
  }

  applyEffects(caster, effects, cell, ctx = {}) {
    // effects with a probability: only one of them happens (Ecaflip...)
    let list = effects.filter(e => !e.chance);
    const random = effects.filter(e => e.chance > 0);
    if (random.length) {
      const total = random.reduce((s, e) => s + e.chance, 0);
      let roll = Math.random() * Math.max(total, 100);
      for (const e of random) { roll -= e.chance; if (roll < 0) { list.push(e); break; } }
    }
    list = effects.filter(e => list.includes(e));
    const origin = ctx.origin ?? caster.cell;
    // buffs created by these effects remember the spell (or weapon) they came from, for the effects window
    const prevSource = this.curSource;
    this.curSource = { spellId: ctx.spellId ?? null, weapon: ctx.weapon ? ctx.weapon.id : null };
    try {
      this.applyEffectList(caster, list, cell, ctx, origin);
    } finally { this.curSource = prevSource; }
  }

  applyEffectList(caster, list, cell, ctx, origin) {
    for (const e of list) {
      if (this.phase !== 'fighting') return;
      const cells = this.map.area(e.area || 'Pa', origin, cell);
      let targets;
      if (ctx.onlyTarget) targets = ctx.onlyTarget.dead ? [] : [ctx.onlyTarget];
      else if ((e.target & 32)) targets = [caster];
      else targets = cells.map(c => this.at(c)).filter(Boolean).filter(t => this.targetOk(caster, t, e.target));
      this.applyEffect(caster, e, cell, targets, cells, ctx);
    }
  }

  applyEffect(caster, e, cell, targets, cells, ctx) {
    const id = e.id;
    const dist = (t) => (e.area && e.area[0] !== 'P' ? this.map.dist(cell, t.cell) : 0);
    const forEach = (fn) => {
      for (let t of targets) {
        if (t.dead || this.phase !== 'fighting') continue;
        // spell return (Feca)
        if (t !== caster && ctx.spellId != null && !ctx.trap && !ctx.glyph && DAMAGE_EFFECTS.has(id) && e.duration === 0) {
          const ret = t.buffs.find(b => b.kind === 'return');
          if (ret && (ctx.sourceLevel || 1) <= Math.max(ret.effect.min, ret.effect.max) && Math.random() * 100 < (ret.effect.special >= 0 ? ret.effect.special : 100)) {
            this.emit({ type: 'log', text: `${t.name} reenvia o feitiço` });
            t = caster;
          }
        }
        fn(t);
      }
    };

    if (DAMAGE[id] || STEAL[id]) {
      const elem = DAMAGE[id] || STEAL[id];
      if (e.duration > 0) { forEach(t => this.addBuff(caster, t, e, { kind: 'dot', elem, steal: !!STEAL[id], spellId: ctx.spellId })); return; }
      forEach(t => {
        let base = rollFor(e, caster);
        if (ctx.spellId != null) for (const b of caster.buffs) if (b.kind === 'spellDmg' && b.spellId === ctx.spellId) base += b.value;
        const dealt = this.damage(caster, t, base, elem, { boosted: true, dist: dist(t), weapon: ctx.weapon, trap: ctx.trap });
        if (STEAL[id] && dealt > 0) this.heal(caster, caster, Math.max(Math.floor(dealt / 2), 1), { raw: true });
      });
      return;
    }
    if (PERCENT_LIFE[id]) {
      forEach(t => {
        const v = Math.floor(caster.life * rollFor(e, caster) / 100);
        if (e.duration > 0) this.addBuff(caster, t, e, { kind: 'dot', elem: PERCENT_LIFE[id], percent: true });
        else this.damage(caster, t, v, PERCENT_LIFE[id], { dist: 0 });
      });
      return;
    }
    if (EFFECT_STATS[id] && ![110].includes(id) || STEAL_STAT[id]) {
      return this.statEffect(caster, e, targets, forEach);
    }
    switch (id) {
      case 4: { // teleport
        if (!this.at(cell) && this.map.cells[cell].walk) {
          caster.cell = cell;
          this.emit({ type: 'tp', id: caster.id, cell });
          this.checkTraps(caster);
        }
        return;
      }
      case 5: forEach(t => this.pushBack(caster, t, rollFor(e, caster), cell)); return;
      case 6: forEach(t => this.pull(caster, t, rollFor(e, caster))); return;
      case 8: forEach(t => { if (t !== caster && !this.hasState(t, STATE_ROOTED)) this.swap(caster, t); }); return;
      case 783: { // move the fighter next to the caster towards the target cell
        const dir = this.map.direction(caster.cell, cell);
        const t = this.at(this.map.next(caster.cell, dir));
        if (t) this.slide(caster, t, dir, Math.max(this.map.dist(caster.cell, cell) - 1, 0), false);
        return;
      }
      case 101: case 127: case 77: case 84: {
        const stat = (id === 101 || id === 84) ? 'ap' : 'mp';
        forEach(t => {
          const lost = this.pointLoss(caster, t, stat, rollFor(e, caster));
          if (lost > 0) {
            this.addBuff(caster, t, e, { kind: 'stat', stat, value: -lost, duration: Math.max(e.duration, 1) });
            if (id === 77 || id === 84) this.addBuff(caster, caster, e, { kind: 'stat', stat, value: lost, duration: Math.max(e.duration, 1) });
          }
        });
        return;
      }
      case 108: case 143: forEach(t => this.heal(caster, t, rollFor(e, caster), { raw: id === 143, dist: dist(t) })); return;
      case 81: forEach(t => this.heal(caster, t, rollFor(e, caster))); return;
      case 90: {
        const v = Math.floor(caster.life * rollFor(e, caster) / 100);
        if (v <= 0) return;
        let gave = false;
        forEach(t => { if (t !== caster) { this.heal(caster, t, v, { raw: true }); gave = true; } });
        if (gave) this.damage(caster, caster, v, 'N', { raw: true });
        return;
      }
      case 82: forEach(t => { const d = this.damage(caster, t, rollFor(e, caster), 'N', {}); if (d > 0) this.heal(caster, caster, Math.max(Math.floor(d / 2), 1), { raw: true }); }); return;
      case 144: forEach(t => this.damage(caster, t, rollFor(e, caster), 'N', {})); return;
      case 109: this.damage(caster, caster, rollFor(e, caster), 'N', { raw: true }); return;
      case 672: {
        const pct = caster.life / caster.maxLife;
        const base = Math.cos(2 * Math.PI * (pct - 0.5)) + 1;
        const factor = base * base / 4 * caster.maxLife;
        forEach(t => this.damage(caster, t, Math.floor(factor * rollFor(e, caster) / 100), 'N', {}));
        return;
      }
      case 105: case 265: forEach(t => this.addBuff(caster, t, e, { kind: 'reduce', value: rollFor(e, caster) })); return;
      case 107: forEach(t => this.addBuff(caster, t, e, { kind: 'reflect', value: rollFor(e, caster) })); return;
      case 106: forEach(t => this.addBuff(caster, t, e, { kind: 'return' })); return;
      case 79: forEach(t => this.addBuff(caster, t, e, { kind: 'healOrMul' })); return;
      case 114: forEach(t => this.addBuff(caster, t, e, { kind: 'multiply', value: e.min })); return;
      case 131: forEach(t => this.addBuff(caster, t, e, { kind: 'apPoison', value: rollFor(e, caster) })); return;
      case 140: forEach(t => this.addBuff(caster, t, e, { kind: 'skip', duration: Math.max(e.duration, 1) })); return;
      case 141: forEach(t => this.kill(t, caster)); return;
      case 132: forEach(t => { for (const b of [...t.buffs]) if (b.dispellable) this.removeBuff(t, b); this.emit({ type: 'log', text: `${t.name} foi desenfeitiçado` }); }); return;
      case 150: forEach(t => { this.addBuff(caster, t, e, { kind: 'invis' }); this.emit({ type: 'invis', id: t.id }); }); return;
      case 202: {
        for (const c of cells) {
          const t = this.at(c);
          if (t && t.team !== caster.team) for (const b of [...t.buffs]) if (b.kind === 'invis') this.removeBuff(t, b);
        }
        for (const tr of this.traps) if (tr.team !== caster.team && tr.cells.some(c => cells.includes(c))) tr.revealed = true;
        return;
      }
      case 950: forEach(t => this.addBuff(caster, t, e, { kind: 'state', state: e.special, duration: e.duration === 0 ? -1 : e.duration })); return;
      case 951: forEach(t => { for (const b of [...t.buffs]) if (b.kind === 'state' && b.state === e.special) this.removeBuff(t, b); }); return;
      case 293: this.addBuff(caster, caster, e, { kind: 'spellDmg', spellId: e.min, value: e.special }); return;
      case 285: this.addBuff(caster, caster, e, { kind: 'spellAp', spellId: e.min, value: e.special }); return;
      case 287: this.addBuff(caster, caster, e, { kind: 'spellCrit', spellId: e.min, value: e.special }); return;
      case 765: forEach(t => { if (t !== caster) this.addBuff(caster, t, e, { kind: 'sacrifice' }); }); return;
      case 788: forEach(t => this.addBuff(caster, t, e, { kind: 'onDamage', stat: ON_DAMAGE_STAT[e.min], max: e.max, statDuration: e.special })); return;
      case 776: forEach(t => this.addBuff(caster, t, e, { kind: 'erosion', value: rollFor(e, caster) })); return;
      case 400: case 401: case 402: return this.placeZone(caster, e, cell);
      case 180: case 181: case 185: case 405: return this.summon(caster, e, cell);
      case 50: { // Karcham: lift an adjacent fighter (the training scarecrow too)
        const t = targets.find(x => x !== caster && (!x.static || x.dummy) && !x.carriedBy && !this.hasState(x, STATE_ROOTED) && !this.hasState(x, STATE_CARRYING));
        if (t && !caster.carrying) this.carry(caster, t);
        return;
      }
      case 51: { // Chamrak: throw whoever is carried onto the target cell
        const t = this.fighter(caster.carrying);
        if (t && !t.dead) this.drop(caster, t, cell, 'throw');
        return;
      }
      case 149: // change of appearance (drunk Pandawa 8010, Zatoishwan 7030); -1 restores the normal look
        forEach(t => {
          t.buffs = t.buffs.filter(b => b.kind !== 'look');
          if (e.special > 0) this.addBuff(caster, t, e, { kind: 'look', gfx: e.special, dispellable: false });
          this.emit({ type: 'look', id: t.id });
        });
        return;
      case 9: // Dérobade: dodge melee attacks by stepping back
        forEach(t => this.addBuff(caster, t, e, { kind: 'evade', duration: e.duration === 0 ? 1 : e.duration }));
        return;
      case -100: // source data has -100 for the level 3 critical fist; it is neutral damage
        forEach(t => this.damage(caster, t, rollFor(e, caster), 'N', { boosted: true, dist: dist(t) }));
        return;
      case 782: forEach(t => this.addBuff(caster, t, e, { kind: 'maxRoll' })); return; // Brokle
      case 781: forEach(t => this.addBuff(caster, t, e, { kind: 'minRoll' })); return; // Poisse
      case 786: forEach(t => this.addBuff(caster, t, e, { kind: 'healOnHit', value: e.special > 0 ? e.special : 100, duration: -1, dispellable: false })); return; // Tree of life
      case 787: // Mot Lotof: the target casts a spell (min, level max) at the start of its next turn
        forEach(t => this.addBuff(caster, t, e, { kind: 'turnSpell', spellCast: e.min, spellLevel: Math.max(e.max, 1), duration: -1 }));
        return;
      case 780: return this.revive(caster, e, cell); // Laisse Spirituelle
      case 784: return this.rewind(); // Raulebaque
      case 130: // steals kamas; this arena has no fight currency
      case 176: // prospecting has no effect in this PvP-only combat
      case 666: // explicit no-op branch in probabilistic spell effects
        return;
      default: {
        const message = `Efeito de combate ${id} sem implementação (feitiço ${ctx.spellId ?? 'desconhecido'})`;
        if (process.env.STRICT_EFFECTS === '1') throw new Error(message);
        this.unhandledEffects ??= new Set();
        if (!this.unhandledEffects.has(id)) { console.warn(message); this.unhandledEffects.add(id); }
        return;
      }
    }
  }

  statEffect(caster, e, targets, forEach) {
    const id = e.id;
    const v = rollFor(e, caster);
    if (STEAL_STAT[id]) {
      const stat = STEAL_STAT[id];
      forEach(t => {
        if (t === caster) return;
        this.addBuff(caster, t, e, { kind: 'stat', stat, value: -v });
        this.addBuff(caster, caster, e, { kind: 'stat', stat, value: v });
      });
      return;
    }
    const [stat, sign] = EFFECT_STATS[id];
    const notDispellable = id >= 606 && id <= 611;
    forEach(t => {
      if ((stat === 'ap' || stat === 'mp') && e.duration === 0) {
        // immediate points for this turn only
        const cur = this.current();
        if (cur === t) { t[stat] = Math.max(0, t[stat] + sign * v); this.emit({ type: stat, id: t.id, value: sign * v }); }
        else this.addBuff(caster, t, e, { kind: 'stat', stat, value: sign * v, duration: 1 });
        return;
      }
      this.addBuff(caster, t, e, { kind: 'stat', stat, value: sign * v, dispellable: !notDispellable });
    });
  }

  addBuff(caster, target, e, props) {
    const b = {
      uid: UID++, casterId: caster.id, targetId: target.id, effect: e, spellId: props.spellId ?? this.curSource?.spellId ?? null,
      weaponId: this.curSource?.weapon ?? null,
      duration: props.duration ?? (e.duration === 0 ? 1 : e.duration), dispellable: true, ...props,
    };
    if (b.duration === 0) b.duration = 1;
    target.buffs.push(b);
    if (b.kind === 'stat') {
      if (b.stat === 'vit') {
        target.maxLife += b.value;
        target.life = Math.max(1, target.life + b.value);
        if (target.life > target.maxLife) target.life = target.maxLife;
      }
      if ((b.stat === 'ap' || b.stat === 'mp') && this.current() === target) target[b.stat] = Math.max(0, target[b.stat] + b.value);
      this.emit({ type: 'stat', id: target.id, stat: b.stat, value: b.value, duration: b.duration });
    } else {
      this.emit({ type: 'buff', id: target.id, kind: b.kind, duration: b.duration, spell: b.spellId });
    }
    return b;
  }

  removeBuff(t, b) {
    const i = t.buffs.indexOf(b);
    if (i < 0) return;
    t.buffs.splice(i, 1);
    if (b.kind === 'stat' && b.stat === 'vit') {
      t.maxLife -= b.value;
      if (b.value > 0) t.life = Math.max(1, t.life - b.value);
      t.life = Math.min(t.life, t.maxLife);
    }
    if (b.kind === 'invis') this.emit({ type: 'reveal', id: t.id, cell: t.cell });
  }

  applyDot(f, b) {
    const caster = this.fighter(b.casterId) || f;
    const e = b.effect;
    if (b.percent) {
      this.damage(caster, f, Math.floor(caster.life * rollFor(e, caster) / 100), b.elem, { indirect: true });
      return;
    }
    const dealt = this.damage(caster, f, rollFor(e, caster), b.elem, { boosted: true, indirect: true });
    if (b.steal && dealt > 0) this.heal(caster, caster, Math.max(Math.floor(dealt / 2), 1), { raw: true });
  }

  pointLoss(caster, target, stat, value) {
    const max = target.base[stat];
    let cur = stat === 'ap' && this.current() === target ? target.ap : (stat === 'mp' && this.current() === target ? target.mp : this.stat(target, stat));
    if (cur <= 0) return 0;
    if (max <= 0) return Math.min(cur, value);
    const res = Math.max(this.stat(target, stat === 'ap' ? 'dodgeAP' : 'dodgeMP'), 1);
    const wis = Math.max(Math.floor(this.stat(caster, 'wis') / 4), 1);
    const rate = 50 * wis / res;
    let lost = 0;
    for (let i = 0; i < value; i++) {
      const after = cur - lost;
      if (after <= 0) break;
      const chance = Math.max(10, Math.min(90, rate * after / max));
      if (Math.random() * 100 < chance) lost++;
    }
    if (value - lost > 0) this.emit({ type: 'dodge', id: target.id, stat, value: value - lost });
    return lost;
  }

  // Applies damage to target. Returns the life actually lost
  damage(caster, target, base, elem, opt = {}) {
    if (target.dead) return 0;
    const E = ELEMENTS[elem];
    let v = base;
    if (opt.boosted) {
      let pct = 100 + this.stat(caster, E.stat) + this.stat(caster, 'pdmg');
      if (opt.trap) pct += this.stat(caster, 'ptrap');
      v = Math.floor(v * Math.max(pct, 0) / 100);
      if (opt.weapon) {
        const skill = CLASSES[caster.cls]?.weapons[opt.weapon.type] ?? 90;
        v = Math.floor(v * skill / 100);
      }
      v += this.stat(caster, 'dmg') + (E.physical ? this.stat(caster, 'phys') : 0) + (opt.trap ? this.stat(caster, 'trap') : 0);
      v = Math.max(v, 0);
    }
    if (opt.dist) v = attenuate(v, opt.dist);
    // Dérobade: a melee hit is dodged by stepping back
    if (!opt.raw && !opt.indirect && !opt.trap && target !== caster && this.map.dist(caster.cell, target.cell) === 1 && !target.carriedBy) {
      const ev = target.buffs.find(x => x.kind === 'evade');
      if (ev && Math.random() * 100 < (ev.effect.min > 0 ? ev.effect.min : 100)) {
        const before = target.cell;
        this.slide(caster, target, this.map.direction(caster.cell, target.cell), Math.max(ev.effect.max, 1), false);
        if (target.cell !== before) { this.emit({ type: 'dodge', id: target.id, stat: 'melee', value: 0 }); return 0; }
      }
    }
    // sacrifice: an ally takes the hit instead
    if (!opt.raw && !opt.indirect && target !== caster) {
      const sac = target.buffs.find(b => b.kind === 'sacrifice');
      const sacrifier = sac && this.fighter(sac.casterId);
      if (sacrifier && !sacrifier.dead && sacrifier !== target) {
        this.swap(sacrifier, target);
        target = sacrifier;
      }
    }
    if (!opt.raw) {
      const rp = Math.min(this.stat(target, E.rp), RES_CAP);
      v = Math.floor(v * (100 - rp) / 100) - this.stat(target, E.rf)
        - this.stat(target, E.physical ? 'rfPhys' : 'rfMagic');
      if (!opt.indirect) {
        let reduce = 0;
        for (const b of target.buffs) {
          if (b.kind !== 'reduce') continue;
          const boost = 200 + this.stat(target, 'int') + this.stat(target, E.stat);
          reduce += Math.max(0, Math.floor(b.value * boost / 200));
        }
        if (reduce > 0) { this.emit({ type: 'reduced', id: target.id, value: reduce }); v -= reduce; }
      }
      v = Math.max(v, 0);
      for (const b of caster.buffs) if (b.kind === 'multiply') v *= b.value;
      const hom = target.buffs.find(b => b.kind === 'healOrMul');
      if (hom && v > 0 && !opt.indirect) {
        if (Math.random() * 100 < hom.effect.special) v *= hom.effect.min;
        else { this.heal(caster, target, v * hom.effect.max, { raw: true }); return 0; }
      }
    }
    const lost = Math.min(v, target.life);
    target.life -= lost;
    // In 1.29 players permanently lose 10% of damage taken from their life ceiling.
    // Effect 776 adds its percentage while the punishment is active.
    if (lost > 0 && target.cls && !target.summoner) {
      const extra = target.buffs.filter(b => b.kind === 'erosion').reduce((n, b) => n + b.value, 0);
      const eroded = Math.min(Math.floor(lost * Math.min(100, 10 + extra) / 100), target.maxLife - 1);
      if (eroded > 0) {
        target.maxLife -= eroded;
        target.life = Math.min(target.life, target.maxLife);
      }
    }
    this.emit({ type: 'damage', id: target.id, value: lost, elem });
    // Arbre de vie: every hit it takes heals everybody else
    const hoh = lost > 0 && !opt.healHook && target.buffs.find(b => b.kind === 'healOnHit');
    if (hoh) {
      const v = Math.floor(lost * hoh.value / 100);
      for (const o of this.fighters) if (o !== target && !o.dead && o.cell >= 0) this.heal(target, o, v, { raw: true });
    }
    // reflected damage
    if (!opt.raw && !opt.indirect && caster !== target && lost > 0) {
      let reflect = Math.max(this.stat(target, 'reflect'), 0);
      for (const b of target.buffs) if (b.kind === 'reflect') reflect += Math.floor(b.value * (100 + this.stat(target, 'wis')) / 100);
      reflect = Math.min(reflect, Math.floor(lost / 2));
      if (reflect > 0 && !caster.dead) {
        this.emit({ type: 'reflect', id: target.id, value: reflect });
        this.damage(target, caster, reflect, 'N', { raw: true });
      }
    }
    // Sacrier punishments: gain characteristics when hit
    if (lost > 0 && !target.dead) {
      for (const b of [...target.buffs]) {
        if (b.kind !== 'onDamage' || !b.stat) continue;
        const current = target.buffs.filter(x => x.kind === 'stat' && x.fromHook === b.uid).reduce((s, x) => s + x.value, 0);
        const gain = Math.min(lost, b.max - current);
        if (gain > 0) {
          const nb = this.addBuff(target, target, b.effect, { kind: 'stat', stat: b.stat, value: gain, duration: b.statDuration + (this.current() === target ? 1 : 0) });
          nb.fromHook = b.uid;
        }
      }
    }
    if (target.life <= 0) this.kill(target, caster);
    return lost;
  }

  heal(caster, target, base, opt = {}) {
    if (target.dead) return 0;
    let v = base;
    if (!opt.raw) v = Math.floor(v * (100 + Math.max(this.stat(caster, 'int'), 0)) / 100) + this.stat(caster, 'heal');
    if (opt.dist) v = attenuate(v, opt.dist);
    v = Math.max(0, Math.min(v, target.maxLife - target.life));
    target.life += v;
    if (v > 0) this.emit({ type: 'heal', id: target.id, value: v });
    return v;
  }

  kill(target, by) {
    if (target.dead) return;
    if (target.dummy && this.mode === 'sandbox') { target.life = target.maxLife; return; }
    target.dead = true;
    target.life = 0;
    this.deaths = [...(this.deaths || []).filter(x => x !== target.id), target.id];
    this.emit({ type: 'die', id: target.id });
    // whoever Laisse Spirituelle brought back dies with the one who cast it
    for (const f of this.fighters) if (f.revivedBy === target.id && !f.dead) this.kill(f, by);
    if (target.carrying) { const t = this.fighter(target.carrying); if (t) this.drop(target, t, target.cell); }
    if (target.carriedBy) { const c = this.fighter(target.carriedBy); if (c) this.drop(c, target, c.carrying === target.id ? c.cell : -1); }
    // summons die with their summoner, zones disappear
    for (const f of this.fighters) if (f.summoner === target.id && !f.dead) this.kill(f, by);
    this.glyphs = this.glyphs.filter(g => g.ownerId !== target.id);
    this.traps = this.traps.filter(t => t.ownerId !== target.id);
    for (const f of this.fighters) f.buffs = f.buffs.filter(b => !(b.kind === 'sacrifice' && b.casterId === target.id));
    this.checkEnd();
    if (this.phase === 'fighting' && this.current() === target) {
      // the current fighter died during his turn
      const pass = () => { if (this.current() === target) this.passTurn(target.id); };
      if (this.timers) setTimeout(pass, 0); else this.pendingPass = pass;
    }
  }

  checkEnd() {
    if (this.phase !== 'fighting') return;
    for (const t of [0, 1]) {
      if (this.fighters.filter(f => f.team === t && !f.summoner).every(f => f.dead)) {
        this.finish(1 - t);
        return;
      }
    }
  }

  forfeit(fid) {
    const f = this.fighter(fid);
    if (!f || this.phase === 'ended') return;
    if (this.phase === 'placement') {
      f.dead = true;
      if (this.fighters.filter(x => x.team === f.team && !x.summoner).every(x => x.dead)) { this.phase = 'fighting'; this.finish(1 - f.team); }
      return;
    }
    this.emit({ type: 'log', text: `${f.name} abandonou a luta` });
    const wasCurrent = this.current() === f;
    this.kill(f, f);
    if (wasCurrent && this.phase === 'fighting') this.passTurn(f.id);
    this.flush();
  }

  finish(winner) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
    clearTimeout(this.timer);
    this.emit({ type: 'end', winner });
    this.flush();
    this.onEnd(this, winner);
  }

  // ---------------------------------------------------------------- movement effects

  slide(caster, t, dir, distance, damageOnBlock) {
    if (this.hasState(t, STATE_ROOTED)) return;
    let cell = t.cell;
    let left = distance;
    for (; left > 0; left--) {
      const n = this.map.next(cell, dir);
      if (n < 0 || !this.map.cells[n].walk || this.at(n)) break;
      cell = n;
      if (this.trapAt(n)) { left = 0; break; }
    }
    if (cell !== t.cell) {
      t.cell = cell;
      this.emit({ type: 'slide', id: t.id, cell });
      this.checkTraps(t);
    }
    if (damageOnBlock && left > 0 && !t.dead) {
      let dmg = (8 + rand(1, 8) * caster.level / 50) * left;
      dmg = Math.floor(dmg);
      this.damage(caster, t, dmg, 'N', { raw: true });
      let next = this.map.next(t.cell, dir);
      for (dmg = Math.floor(dmg / 2); dmg > 0 && next >= 0; dmg = Math.floor(dmg / 2)) {
        const o = this.at(next);
        if (!o) break;
        this.damage(caster, o, dmg, 'N', { raw: true });
        next = this.map.next(next, dir);
      }
    }
  }

  pushBack(caster, t, distance, castCell) {
    if (t === caster) return;
    const from = t.cell === castCell ? caster.cell : castCell;
    this.slide(caster, t, this.map.direction(from, t.cell), distance, true);
  }

  pull(caster, t, distance) {
    if (t === caster) return;
    const dir = this.map.direction(t.cell, caster.cell);
    const d = Math.min(distance, this.map.dist(t.cell, caster.cell) - 1);
    if (d > 0) this.slide(caster, t, dir, d, false);
  }

  carry(carrier, t) {
    carrier.carrying = t.id;
    t.carriedBy = carrier.id;
    // the carried fighter follows the carrier wherever it goes
    Object.defineProperty(t, 'cell', { get: () => carrier.cell, set() {}, configurable: true, enumerable: true });
    this.addBuff(carrier, carrier, { id: 950, min: -1, max: -1, special: STATE_CARRYING, duration: -1 }, { kind: 'state', state: STATE_CARRYING, duration: -1, dispellable: false, carry: true });
    this.addBuff(carrier, t, { id: 950, min: -1, max: -1, special: STATE_CARRIED, duration: -1 }, { kind: 'state', state: STATE_CARRIED, duration: -1, dispellable: false, carry: true });
    this.emit({ type: 'carry', id: carrier.id, target: t.id });
  }

  // puts the carried fighter down on `cell` (thrown, or dropped when the carrier dies)
  drop(carrier, t, cell, how = 'drop') {
    const from = carrier.cell;
    delete t.cell;
    if (cell == null || cell < 0 || this.at(cell) || !this.map.cells[cell]?.walk) {
      cell = [from, ...this.map.neighbors(from)].find(c => c >= 0 && this.map.cells[c]?.walk && !this.at(c)) ?? from;
    }
    t.cell = cell;
    delete t.carriedBy;
    delete carrier.carrying;
    for (const f of [carrier, t]) f.buffs = f.buffs.filter(b => !b.carry);
    this.emit({ type: how, id: carrier.id, target: t.id, cell });
    if (!t.dead) this.checkTraps(t);
  }

  swap(a, b) {
    const c = a.cell;
    a.cell = b.cell;
    b.cell = c;
    this.emit({ type: 'tp', id: a.id, cell: a.cell });
    this.emit({ type: 'tp', id: b.id, cell: b.cell });
  }

  // ---------------------------------------------------------------- traps, glyphs, summons

  placeZone(caster, e, cell) {
    const sp = this.spellDef(e.min);
    if (!sp) return;
    const area = e.area || 'Pa';
    // 1.29 GDZ "+cell;size;color": color is an index in the lang config ZONE_COLOR
    const zone = { id: UID++, ownerId: caster.id, team: caster.team, cell, cells: this.map.area(area, cell, cell), spell: e.min, level: Math.max(e.max, 1), color: e.special,
      size: area[0] === 'C' ? Math.max(ZONE_SIZE_CHARS.indexOf(area[1] || 'a'), 0) : 0, rgb: zoneRgb(e.special) };
    if (e.id === 400) {
      if (this.at(cell) || this.traps.some(t => t.cell === cell)) return;
      this.traps.push(zone);
      this.emit({ type: 'trapSet', team: caster.team, id: zone.id });
    } else {
      zone.duration = Math.max(e.duration, 1);
      zone.endTurn = e.id === 402;
      this.glyphs.push(zone);
      this.emit({ type: 'glyph', id: zone.id });
    }
  }

  // the last ally of the caster that died comes back on `cell` with min% of its life (Laisse Spirituelle)
  revive(caster, e, cell) {
    if (this.at(cell) || !this.map.cells[cell]?.walk) return;
    const id = [...(this.deaths || [])].reverse().find(x => { const f = this.fighter(x); return f && f.dead && f.team === caster.team && f !== caster && !f.summoner; });
    const f = id && this.fighter(id);
    if (!f) return;
    f.dead = false;
    f.cell = cell;
    f.buffs = [];
    f.life = Math.max(1, Math.floor(f.maxLife * Math.max(e.min, 1) / 100));
    f.revivedBy = caster.id;
    this.deaths = this.deaths.filter(x => x !== id);
    this.emit({ type: 'revive', id: f.id, cell, by: caster.id });
    this.emit({ type: 'tp', id: f.id, cell });
    this.checkTraps(f);
  }

  // every fighter goes back to the cell where it started the fight, when that cell is free (Raulebaque)
  rewind() {
    for (const f of this.fighters) {
      if (f.dead || f.carriedBy || f.startCell == null || f.startCell < 0 || f.cell === f.startCell) continue;
      const o = this.at(f.startCell);
      if (o && o !== f) continue;
      f.cell = f.startCell;
      this.emit({ type: 'tp', id: f.id, cell: f.cell });
    }
  }

  summon(caster, e, cell) {
    if (this.at(cell) || !this.map.cells[cell].walk) return;
    let f;
    const id = Math.max(...this.fighters.map(x => x.id)) + 1;
    if (e.id === 180) {
      // double: same characteristics and life as the caster, no spells
      f = {
        ...JSON.parse(JSON.stringify({ base: caster.base })), id, team: caster.team, name: `Duplo de ${caster.name}`,
        cls: caster.cls, gfx: caster.gfx, level: caster.level, summoner: caster.id, static: false, bot: true,
        life: caster.life, maxLife: caster.life, baseMaxLife: caster.life, cell, dead: false, ap: 0, mp: 0,
        buffs: [], spells: [], weapon: null, consumables: [], cooldowns: {}, turnCasts: {}, turnTargets: {}, apUsed: 0, connected: true, double: true,
      };
    } else {
      const mon = this.data.monsters[e.min];
      if (!mon) return;
      const g = mon.grades[Math.min(Math.max(e.max, 1), mon.grades.length) - 1];
      const scale = 1 + caster.level / 100;
      const base = Object.fromEntries(STAT_KEYS.map(k => [k, 0]));
      const [str, wis, int, cha, agi] = g.stats;
      Object.assign(base, {
        ap: g.ap, mp: g.mp, str: Math.floor(str * scale), wis: Math.floor(wis * scale), int: Math.floor(int * scale),
        cha: Math.floor(cha * scale), agi: Math.floor(agi * scale), init: g.init,
        summons: 1, rpN: g.res[0], rpE: g.res[1], rpF: g.res[2], rpW: g.res[3], rpA: g.res[4], dodgeAP: g.res[5], dodgeMP: g.res[6],
      });
      const life = Math.floor(g.life * scale);
      f = {
        id, team: caster.team, name: mon.name.trim().replace(/\s*\(Invocation\)/, ''), monster: mon.id, gfx: mon.gfx,
        cls: 0, level: g.level, summoner: caster.id, static: e.id === 185 || g.ap === 0, bot: true,
        base, life, maxLife: life, baseMaxLife: life, cell, dead: false, ap: 0, mp: 0, buffs: [],
        spells: g.spells.filter(([sid]) => this.data.spells[sid]).map(([sid, lvl]) => ({ id: sid, level: Math.min(lvl, this.data.spells[sid].levels.length) })),
        weapon: null, consumables: [], cooldowns: {}, turnCasts: {}, turnTargets: {}, apUsed: 0, connected: true,
      };
    }
    this.fighters.push(f);
    // plays right after its summoner (and his previous summons)
    let idx = this.order.indexOf(caster.id);
    while (idx + 1 < this.order.length && this.fighter(this.order[idx + 1])?.summoner === caster.id) idx++;
    this.order.splice(idx + 1, 0, f.id);
    if (idx + 1 <= this.turnIndex) this.turnIndex++;
    this.emit({ type: 'summon', id: f.id, by: caster.id, cell });
    this.checkTraps(f);
  }

  // ---------------------------------------------------------------- state sent to clients

  view(team) {
    const fighters = this.fighters.map(f => {
      const hidden = this.invisible(f) && f.team !== team;
      return {
        id: f.id, team: f.team, name: f.name, cls: f.cls, level: f.level, monster: f.monster || null, gfx: f.gfx,
        summoner: f.summoner, static: f.static, double: !!f.double, dummy: !!f.dummy, bot: f.bot && !f.summoner,
        life: f.life, maxLife: f.maxLife, cell: hidden ? -1 : f.cell, dead: f.dead, invisible: this.invisible(f),
        ap: f.ap, mp: f.mp, ready: !!f.ready, connected: f.connected, carriedBy: f.carriedBy || null, carrying: f.carrying || null,
        stats: Object.fromEntries(STAT_KEYS.map(k => [k, this.stat(f, k)])),
        // everything the 1.29 buff tooltip shows: effect, value, turns left, caster and spell
        buffs: f.buffs.map(b => ({
          uid: b.uid, kind: b.kind, stat: b.stat, value: b.value, duration: b.duration, spell: b.spellId, weapon: b.weaponId || undefined,
          state: b.state, caster: b.casterId, elem: b.elem, dispellable: b.dispellable !== false,
          effect: b.effect ? { id: b.effect.id, min: b.effect.min, max: b.effect.max, special: b.effect.special } : null,
        })),
        spells: f.team === team ? f.spells : undefined,
        slots: f.team === team ? f.slots || null : undefined,
        weapon: f.team === team && f.weapon ? f.weapon.id : undefined,
        consumables: f.team === team ? f.consumables : undefined,
        cooldowns: f.team === team ? f.cooldowns : undefined,
        usable: f.team === team && f.spells ? this.usableMap(f) : undefined,
        look: f.buffs.filter(b => b.kind === 'look').at(-1)?.gfx || null,
        turnCasts: f.team === team ? f.turnCasts : undefined,
        turnTargets: f.team === team ? f.turnTargets : undefined,
      };
    });
    return {
      id: this.id, mode: this.mode, phase: this.phase, round: this.round, ranked: this.ranked,
      current: this.phase === 'fighting' ? this.order[this.turnIndex] : null, order: this.order,
      deadline: this.deadline, winner: this.winner,
      traps: this.traps.filter(t => t.team === team || t.revealed).map(t => ({ id: t.id, spell: t.spell, cell: t.cell, cells: t.cells, size: t.size, team: t.team, color: t.color, rgb: t.rgb })),
      glyphs: this.glyphs.map(g => ({ id: g.id, spell: g.spell, cell: g.cell, cells: g.cells, size: g.size, team: g.team, color: g.color, rgb: g.rgb, duration: g.duration })),
      fighters,
    };
  }

  flush() {
    this.refill();
    const events = this.events;
    this.events = [];
    this.onUpdate(this, events);
  }
}

// Invisible fighters (1.29): their own team gets the whole path and walks them at reduced alpha;
// enemies only learn that they moved, never the path or the cell.
export function filterEvents(events, team, fight) {
  const enemy = (ev) => { const f = fight.fighter(ev.id); return f && f.team !== team; };
  return events.filter(ev => !(ev.type === 'trapSet' && ev.team !== team))
    .filter(ev => !((ev.type === 'slide' || ev.type === 'tp') && ev.hidden && enemy(ev)))
    .map(ev => (ev.type === 'move' && ev.hidden && enemy(ev) ? { type: 'move', id: ev.id, hidden: true } : ev));
}
